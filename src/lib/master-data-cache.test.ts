import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MISSING_READ_MODEL_CACHE_TTL_MS } from "./read-model-rollout";
import {
  loadActiveEmployeeOptions,
  loadActiveInstitutionOptions,
  loadActiveItemOptions,
  loadEmployeeMasterData,
  loadHrRequestMasterData,
  safeHrRequestMasterDataErrorMessage,
  loadOrganizationMasterData,
  loadProductMasterData,
  loadProcurementMasterData,
  invalidateMasterDataCache,
} from "./master-data-cache";

function queryBuilder(result: unknown) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(async () => result),
  };
  return builder;
}

function clientFrom(builders: Record<string, ReturnType<typeof queryBuilder>>): SupabaseClient {
  return {
    from: vi.fn((table: string) => builders[table]),
    auth: { refreshSession: vi.fn() },
  } as unknown as SupabaseClient;
}

describe("master data cache projections", () => {
  it("shows safe resource and allowlisted error codes without raw database details", () => {
    const message = safeHrRequestMasterDataErrorMessage([
      { resource: "employees", code: "42501", message: "permission denied for relation employees; token=secret" },
      { resource: "uniform_items", code: "PGRST205", message: "Could not find internal relation detail" },
      { resource: "departments", code: "secret", message: "internal stack detail" },
    ]);

    expect(message).toContain("員工主檔：42501");
    expect(message).toContain("制服品號／庫存：PGRST205");
    expect(message).toContain("部門：未知代碼");
    expect(message).not.toContain("permission denied");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("internal");
  });

  it("falls back to RLS-backed base reads when the 0104 HR option views are not deployed", async () => {
    const missingView = (name: string) => queryBuilder({
      data: null,
      error: { code: "PGRST205", message: `Could not find the table 'public.${name}' in the schema cache` },
    });
    const employeeView = missingView("v_hr_request_employee_options");
    const itemView = missingView("v_hr_request_item_options");
    const employees = queryBuilder({ data: [
      {
        id: "employee-valid", employee_no: "E001", name: "員工甲", institution_id: "institution-1", department_id: "department-1", employment_status: "ACTIVE",
        institution: { id: "institution-1", code: "A", name: "清福", is_active: true },
        department: { id: "department-1", institution_id: "institution-1", code: "D1", name: "人資部", is_active: true },
      },
      {
        id: "employee-inactive", employee_no: "E002", name: "員工乙", institution_id: "institution-1", department_id: "department-1", employment_status: "INACTIVE",
        institution: { id: "institution-1", code: "A", name: "清福", is_active: true },
        department: { id: "department-1", institution_id: "institution-1", code: "D1", name: "人資部", is_active: true },
      },
      {
        id: "employee-wrong-parent", employee_no: "E003", name: "員工丙", institution_id: "institution-2", department_id: "department-1", employment_status: "ACTIVE",
        institution: { id: "institution-2", code: "B", name: "停用機構", is_active: false },
        department: { id: "department-1", institution_id: "institution-1", code: "D1", name: "人資部", is_active: true },
      },
    ], error: null });
    const institutions = queryBuilder({ data: [
      { id: "institution-1", code: "A", name: "清福", is_active: true },
      { id: "institution-2", code: "B", name: "停用機構", is_active: false },
    ], error: null });
    const departments = queryBuilder({ data: [
      { id: "department-1", institution_id: "institution-1", code: "D1", name: "人資部", is_active: true },
      { id: "department-2", institution_id: "institution-1", code: "D2", name: "停用部門", is_active: false },
    ], error: null });
    const availability = queryBuilder({ data: [
      { item_id: "item-1", item_code: "U001", item_name: "制服上衣", size: "M", unit: "件", is_active: true, hr_on_hand_quantity: 2, general_on_hand_quantity: 8, active_reserved_quantity: 1 },
      { item_id: "item-inactive", item_code: "U002", item_name: "停用品號", size: null, unit: "件", is_active: false, hr_on_hand_quantity: 0, general_on_hand_quantity: 0, active_reserved_quantity: 0 },
    ], error: null });
    const client = clientFrom({
      v_hr_request_employee_options: employeeView,
      v_hr_request_item_options: itemView,
      employees,
      institutions,
      departments,
      v_item_availability: availability,
    });

    await expect(loadHrRequestMasterData(client)).resolves.toEqual({
      employees: [{
        id: "employee-valid",
        employee_no: "E001",
        name: "員工甲",
        institution_id: "institution-1",
        institution_code: "A",
        institution_name: "清福",
        department_id: "department-1",
        department_code: "D1",
        department_name: "人資部",
      }],
      items: [{
        id: "item-1",
        item_code: "U001",
        item_name: "制服上衣",
        size: "M",
        unit: "件",
        hr_on_hand_quantity: 2,
        general_on_hand_quantity: 8,
        active_reserved_quantity: 1,
      }],
      errors: [],
    });
    expect(client.from).toHaveBeenCalledTimes(4);
    expect(employees.select).toHaveBeenCalledWith(expect.stringContaining("institution:institutions!employees_institution_id_fkey("));
    expect(employees.select).toHaveBeenCalledWith(expect.stringContaining("department:departments!employees_department_id_institution_id_fkey("));

    invalidateMasterDataCache(client, "hr-request");
    await expect(loadHrRequestMasterData(client)).resolves.toMatchObject({ errors: [] });
    expect(client.from).toHaveBeenCalledTimes(6);
    expect(client.from).toHaveBeenNthCalledWith(5, "employees");
  });

  it("does not probe missing HR option views again after the data snapshot expires", async () => {
    vi.useFakeTimers();
    try {
      const missingView = (name: string) => queryBuilder({
        data: null,
        error: { code: "PGRST205", message: `Could not find the table 'public.${name}' in the schema cache` },
      });
      const builders = {
        v_hr_request_employee_options: missingView("v_hr_request_employee_options"),
        v_hr_request_item_options: missingView("v_hr_request_item_options"),
        employees: queryBuilder({ data: [{
          id: "employee-1",
          employee_no: "E001",
          name: "員工甲",
          institution_id: "institution-1",
          department_id: "department-1",
          employment_status: "ACTIVE",
          institution: { id: "institution-1", code: "A", name: "清福", is_active: true },
          department: { id: "department-1", institution_id: "institution-1", code: "D1", name: "人資部", is_active: true },
        }], error: null }),
        v_item_availability: queryBuilder({ data: [{
          item_id: "item-1",
          item_code: "U001",
          item_name: "制服上衣",
          size: "M",
          unit: "件",
          is_active: true,
          hr_on_hand_quantity: 2,
          general_on_hand_quantity: 8,
          active_reserved_quantity: 1,
        }], error: null }),
      };
      const requestedTables: string[] = [];
      const client = {
        from: vi.fn((table: keyof typeof builders) => {
          requestedTables.push(table);
          return builders[table];
        }),
        auth: { refreshSession: vi.fn() },
      } as unknown as SupabaseClient;

      const firstRead = await loadHrRequestMasterData(client);
      expect(firstRead.errors).toEqual([]);
      expect(requestedTables).toEqual([
        "v_hr_request_employee_options",
        "v_hr_request_item_options",
        "employees",
        "v_item_availability",
      ]);

      invalidateMasterDataCache(client, "hr-request");
      await expect(loadHrRequestMasterData(client)).resolves.toEqual(firstRead);
      vi.setSystemTime(new Date(Date.now() + 30_001));
      await expect(loadHrRequestMasterData(client)).resolves.toEqual(firstRead);
      expect(requestedTables).toEqual([
        "v_hr_request_employee_options",
        "v_hr_request_item_options",
        "employees",
        "v_item_availability",
        "employees",
        "v_item_availability",
        "employees",
        "v_item_availability",
      ]);

      vi.advanceTimersByTime(MISSING_READ_MODEL_CACHE_TTL_MS);
      await expect(loadHrRequestMasterData(client)).resolves.toEqual(firstRead);
      expect(requestedTables).toEqual([
        "v_hr_request_employee_options",
        "v_hr_request_item_options",
        "employees",
        "v_item_availability",
        "employees",
        "v_item_availability",
        "employees",
        "v_item_availability",
        "v_hr_request_employee_options",
        "v_hr_request_item_options",
        "employees",
        "v_item_availability",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry an unavailable HR employee join after the data snapshot expires", async () => {
    vi.useFakeTimers();
    try {
      const missingEmployeeView = queryBuilder({
        data: null,
        error: { code: "PGRST205", message: "Could not find the table 'public.v_hr_request_employee_options' in the schema cache" },
      });
      const itemView = queryBuilder({ data: [{
        id: "item-1",
        item_code: "U001",
        item_name: "制服上衣",
        size: "M",
        unit: "件",
        hr_on_hand_quantity: 2,
        general_on_hand_quantity: 8,
        active_reserved_quantity: 1,
      }], error: null });
      const failedEmployeeJoin = queryBuilder({
        data: null,
        error: { code: "PGRST200", message: "PostgREST relationship metadata is unavailable" },
      });
      const employeeRows = queryBuilder({ data: [{
        id: "employee-1",
        employee_no: "E001",
        name: "員工甲",
        institution_id: "institution-1",
        department_id: "department-1",
        employment_status: "ACTIVE",
        institution: { id: "institution-1", code: "A", name: "清福", is_active: true },
        department: { id: "department-1", institution_id: "institution-1", code: "D1", name: "人資部", is_active: true },
      }], error: null });
      const institutions = queryBuilder({ data: [
        { id: "institution-1", code: "A", name: "清福", is_active: true },
      ], error: null });
      const departments = queryBuilder({ data: [
        { id: "department-1", institution_id: "institution-1", code: "D1", name: "人資部", is_active: true },
      ], error: null });
      const employeeReads = [failedEmployeeJoin, employeeRows, employeeRows, employeeRows];
      const requestedTables: string[] = [];
      const client = {
        from: vi.fn((table: string) => {
          requestedTables.push(table);
          if (table === "employees") return employeeReads.shift() ?? employeeRows;
          if (table === "institutions") return institutions;
          if (table === "departments") return departments;
          if (table === "v_hr_request_employee_options") return missingEmployeeView;
          if (table === "v_hr_request_item_options") return itemView;
          throw new Error(`Unexpected table ${table}`);
        }),
        auth: { refreshSession: vi.fn() },
      } as unknown as SupabaseClient;

      const firstRead = await loadHrRequestMasterData(client);
      expect(firstRead.errors).toEqual([]);
      expect(requestedTables).toEqual([
        "v_hr_request_employee_options",
        "v_hr_request_item_options",
        "employees",
        "employees",
        "institutions",
        "departments",
      ]);

      vi.setSystemTime(new Date(Date.now() + 30_001));
      await expect(loadHrRequestMasterData(client)).resolves.toEqual(firstRead);
      expect(requestedTables).toEqual([
        "v_hr_request_employee_options",
        "v_hr_request_item_options",
        "employees",
        "employees",
        "institutions",
        "departments",
        "v_hr_request_item_options",
        "employees",
        "institutions",
        "departments",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fall back or hide an authorization failure on an HR option view", async () => {
    const employeeView = queryBuilder({ data: null, error: { code: "42501", message: "permission denied" } });
    const itemView = queryBuilder({ data: [], error: null });
    const client = clientFrom({
      v_hr_request_employee_options: employeeView,
      v_hr_request_item_options: itemView,
    });

    const result = await loadHrRequestMasterData(client);

    expect(result.errors.map((error) => ({ resource: error.resource, code: error.code }))).toEqual([
      { resource: "employees", code: "42501" },
    ]);
    expect(client.from).toHaveBeenCalledTimes(2);
  });

  it("falls back only for the missing HR option view and keeps the deployed view path", async () => {
    const employeeView = queryBuilder({
      data: null,
      error: { code: "PGRST205", message: "Could not find the table 'public.v_hr_request_employee_options' in the schema cache" },
    });
    const itemView = queryBuilder({
      data: [{
        id: "item-1",
        item_code: "U001",
        item_name: "制服上衣",
        size: "M",
        unit: "件",
        hr_on_hand_quantity: 2,
        general_on_hand_quantity: 8,
        active_reserved_quantity: 1,
      }],
      error: null,
    });
    const employees = queryBuilder({ data: [
      {
        id: "employee-1", employee_no: "E001", name: "員工甲", institution_id: "institution-1", department_id: "department-1", employment_status: "ACTIVE",
        institution: { id: "institution-1", code: "A", name: "清福", is_active: true },
        department: { id: "department-1", institution_id: "institution-1", code: "D1", name: "人資部", is_active: true },
      },
    ], error: null });
    const institutions = queryBuilder({ data: [
      { id: "institution-1", code: "A", name: "清福", is_active: true },
    ], error: null });
    const departments = queryBuilder({ data: [
      { id: "department-1", institution_id: "institution-1", code: "D1", name: "人資部", is_active: true },
    ], error: null });
    const client = clientFrom({
      v_hr_request_employee_options: employeeView,
      v_hr_request_item_options: itemView,
      employees,
      institutions,
      departments,
    });

    await expect(loadHrRequestMasterData(client)).resolves.toMatchObject({
      employees: [{ id: "employee-1", institution_code: "A", department_code: "D1" }],
      items: [{ id: "item-1", item_code: "U001" }],
      errors: [],
    });
    expect(client.from).toHaveBeenCalledTimes(3);
  });

  it.each(["PGRST200", "PGRST201"] as const)(
    "keeps the legacy employee reads compatible when PostgREST cannot resolve an embedded FK (%s)",
    async (relationshipErrorCode) => {
      const employeeView = queryBuilder({
        data: null,
        error: {
          code: "PGRST205",
          message: "Could not find the table 'public.v_hr_request_employee_options' in the schema cache",
        },
      });
      const itemView = queryBuilder({
        data: [{
          id: "item-1",
          item_code: "U001",
          item_name: "制服上衣",
          size: "M",
          unit: "件",
          hr_on_hand_quantity: 2,
          general_on_hand_quantity: 8,
          active_reserved_quantity: 1,
        }],
        error: null,
      });
      const embeddedEmployees = queryBuilder({
        data: null,
        error: { code: relationshipErrorCode, message: "PostgREST relationship metadata is unavailable" },
      });
      const employees = queryBuilder({
        data: [{
          id: "employee-1",
          employee_no: "E001",
          name: "員工甲",
          institution_id: "institution-1",
          department_id: "department-1",
          employment_status: "ACTIVE",
        }],
        error: null,
      });
      const institutions = queryBuilder({
        data: [{ id: "institution-1", code: "A", name: "清福", is_active: true }],
        error: null,
      });
      const departments = queryBuilder({
        data: [{ id: "department-1", institution_id: "institution-1", code: "D1", name: "人資部", is_active: true }],
        error: null,
      });
      const pendingBuilders: Record<string, ReturnType<typeof queryBuilder>[]> = {
        v_hr_request_employee_options: [employeeView],
        v_hr_request_item_options: [itemView],
        employees: [embeddedEmployees, employees],
        institutions: [institutions],
        departments: [departments],
      };
      const from = vi.fn((table: string) => {
        const builder = pendingBuilders[table]?.shift();
        if (!builder) throw new Error(`Unexpected read from ${table}`);
        return builder;
      });
      const client = {
        from,
        auth: { refreshSession: vi.fn() },
      } as unknown as SupabaseClient;

      await expect(loadHrRequestMasterData(client)).resolves.toMatchObject({
        employees: [{
          id: "employee-1",
          institution_code: "A",
          department_code: "D1",
        }],
        items: [{ id: "item-1", item_code: "U001" }],
        errors: [],
      });
      expect(from).toHaveBeenCalledTimes(6);
      expect(embeddedEmployees.select).toHaveBeenCalledWith(expect.stringContaining("employees_department_id_institution_id_fkey"));
      expect(employees.select).toHaveBeenCalledWith("id,employee_no,name,institution_id,department_id,employment_status");
    },
  );

  it("projects active item options from an already loaded product snapshot", async () => {
    const items = queryBuilder({
      data: [
        { id: "item-1", item_code: "A", item_name: "上衣", unit: "件", size: "M", category: null, season: null, is_active: true },
        { id: "item-2", item_code: "B", item_name: "長褲", unit: "件", size: "L", category: null, season: null, is_active: false },
      ],
      error: null,
    });
    const suppliers = queryBuilder({ data: [], error: null });
    const relations = queryBuilder({ data: [], error: null });
    const client = clientFrom({ uniform_items: items, suppliers, supplier_uniform_items: relations });

    await loadProductMasterData(client);
    await expect(loadActiveItemOptions(client)).resolves.toEqual({
      items: [{ id: "item-1", item_code: "A", item_name: "上衣", unit: "件", size: "M" }],
      errors: [],
    });
    expect(client.from).toHaveBeenCalledTimes(3);
  });

  it("reuses suppliers and MOQ rows while loading only procurement reasons", async () => {
    const items = queryBuilder({ data: [], error: null });
    const suppliers = queryBuilder({
      data: [
        { id: "supplier-1", supplier_code: "S1", name: "供應商一", default_currency: "TWD", is_active: true },
        { id: "supplier-2", supplier_code: "S2", name: "停用供應商", default_currency: "TWD", is_active: false },
      ],
      error: null,
    });
    const relations = queryBuilder({
      data: [{ item_id: "item-1", supplier_id: "supplier-1", minimum_order_quantity: 10, supplier_item_code: "S-A", is_active: true }],
      error: null,
    });
    const reasons = queryBuilder({ data: [{ code: "SHORT", name: "短發" }], error: null });
    const client = clientFrom({ uniform_items: items, suppliers, supplier_uniform_items: relations, procurement_difference_reasons: reasons });

    await loadProductMasterData(client);
    await expect(loadProcurementMasterData(client)).resolves.toEqual({
      suppliers: [{ id: "supplier-1", supplier_code: "S1", name: "供應商一", default_currency: "TWD" }],
      supplierItems: [{ item_id: "item-1", supplier_id: "supplier-1", minimum_order_quantity: 10 }],
      differenceReasons: [{ code: "SHORT", name: "短發" }],
      errors: [],
    });
    expect(client.from).toHaveBeenCalledTimes(4);
  });

  it("projects active organization and employee options from full snapshots", async () => {
    const institutions = queryBuilder({
      data: [
        { id: "institution-1", code: "A", name: "清福", is_active: true },
        { id: "institution-2", code: "B", name: "停用機構", is_active: false },
      ],
      error: null,
    });
    const departments = queryBuilder({ data: [], error: null });
    const organizationClient = clientFrom({ institutions, departments });
    await loadOrganizationMasterData(organizationClient);
    await expect(loadActiveInstitutionOptions(organizationClient)).resolves.toEqual({
      institutions: [{ id: "institution-1", code: "A", name: "清福" }],
      errors: [],
    });
    expect(organizationClient.from).toHaveBeenCalledTimes(2);

    const employees = queryBuilder({
      data: [
        { id: "employee-1", employee_no: "E1", name: "王小明", institution_id: "institution-1", department_id: "department-1", employment_status: "ACTIVE", job_title: null, hire_date: null, termination_date: null, note: null },
        { id: "employee-2", employee_no: "E2", name: "李小華", institution_id: "institution-1", department_id: "department-1", employment_status: "INACTIVE", job_title: null, hire_date: null, termination_date: null, note: null },
      ],
      error: null,
    });
    const employeeClient = clientFrom({ employees });
    await loadEmployeeMasterData(employeeClient);
    await expect(loadActiveEmployeeOptions(employeeClient)).resolves.toEqual({
      employees: [{ id: "employee-1", employee_no: "E1", name: "王小明", institution_id: "institution-1", department_id: "department-1" }],
      errors: [],
    });
    expect(employeeClient.from).toHaveBeenCalledTimes(1);
  });

  it("invalidates source snapshots together with their derived projections", async () => {
    const items = queryBuilder({ data: [], error: null });
    const suppliers = queryBuilder({ data: [], error: null });
    const relations = queryBuilder({ data: [], error: null });
    const reasons = queryBuilder({ data: [], error: null });
    const client = clientFrom({ uniform_items: items, suppliers, supplier_uniform_items: relations, procurement_difference_reasons: reasons });

    await loadProductMasterData(client);
    await loadProcurementMasterData(client);
    await loadActiveItemOptions(client);
    expect(client.from).toHaveBeenCalledTimes(4);

    invalidateMasterDataCache(client, "product");
    await loadProcurementMasterData(client);
    await loadActiveItemOptions(client);
    expect(client.from).toHaveBeenCalledTimes(8);
  });
});
