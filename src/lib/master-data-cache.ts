import type { SupabaseClient } from "@supabase/supabase-js";
import { MISSING_READ_MODEL_CACHE_TTL_MS } from "./read-model-rollout";
import {
  buildHrEmployeeOptionRowsFromJoinedData,
  buildHrEmployeeOptionRowsFromMasterData,
  type HrDepartmentOptionSourceRow,
  type HrEmployeeJoinedOptionSourceRow,
  type HrEmployeeMasterSourceRow,
  type HrEmployeeOptionSourceRow,
  type HrInstitutionOptionSourceRow,
} from "../domain/hr-employee-options";
import { retrySupabaseQueriesAfterSessionRefresh } from "./supabase-session";

export type MasterDataInstitution = { id: string; code: string; name: string; is_active: boolean };
export type MasterDataDepartment = { id: string; institution_id: string; code: string; name: string; is_active: boolean };
export type MasterDataItem = { id: string; item_code: string; item_name: string; unit: string; size: string | null; category: string | null; season: string | null; is_active: boolean };
export type MasterDataSupplier = { id: string; supplier_code: string; name: string; default_currency: string | null; is_active: boolean };
export type MasterDataSupplierItem = { item_id: string; supplier_id: string; minimum_order_quantity: number | null; supplier_item_code: string | null; is_active: boolean };
export type MasterDataEmployee = {
  id: string;
  employee_no: string;
  name: string;
  institution_id: string;
  department_id: string;
  employment_status: "ACTIVE" | "INACTIVE";
  job_title: string | null;
  hire_date: string | null;
  termination_date: string | null;
  note: string | null;
};

export type MasterDataReadError = {
  resource: "institutions" | "departments" | "uniform_items" | "suppliers" | "supplier_uniform_items" | "procurement_difference_reasons" | "employees" | "warehouses";
  code?: string | null;
  message: string;
};

export type OrganizationMasterData = {
  institutions: MasterDataInstitution[];
  departments: MasterDataDepartment[];
  errors: MasterDataReadError[];
};

export type ProductMasterData = {
  items: MasterDataItem[];
  suppliers: MasterDataSupplier[];
  supplierItems: MasterDataSupplierItem[];
  errors: MasterDataReadError[];
};

export type ProcurementSupplierOption = Pick<MasterDataSupplier, "id" | "supplier_code" | "name" | "default_currency">;
export type ProcurementSupplierItemOption = Pick<MasterDataSupplierItem, "item_id" | "supplier_id" | "minimum_order_quantity">;
export type ProcurementDifferenceReasonOption = { code: string; name: string };
export type ProcurementMasterData = {
  suppliers: ProcurementSupplierOption[];
  supplierItems: ProcurementSupplierItemOption[];
  differenceReasons: ProcurementDifferenceReasonOption[];
  errors: MasterDataReadError[];
};

export type EmployeeMasterData = {
  employees: MasterDataEmployee[];
  errors: MasterDataReadError[];
};

export type ActiveEmployeeOption = Pick<MasterDataEmployee, "id" | "employee_no" | "name" | "institution_id" | "department_id">;
export type ActiveEmployeeMasterData = { employees: ActiveEmployeeOption[]; errors: MasterDataReadError[] };

export type HrRequestItemOption = Pick<MasterDataItem, "id" | "item_code" | "item_name" | "size" | "unit"> & {
  hr_on_hand_quantity: number;
  general_on_hand_quantity: number;
  active_reserved_quantity: number;
};
export type HrRequestMasterData = {
  employees: HrEmployeeOptionSourceRow[];
  items: HrRequestItemOption[];
  errors: MasterDataReadError[];
};

export type ActiveItemOption = Pick<MasterDataItem, "id" | "item_code" | "item_name" | "unit" | "size">;
export type ActiveInstitutionOption = Pick<MasterDataInstitution, "id" | "code" | "name">;
export type ActiveWarehouseOption = Pick<MasterDataWarehouse, "id" | "code" | "name" | "purpose">;
export type MasterDataWarehouse = {
  id: string;
  code: string;
  name: string;
  purpose: "HR" | "GENERAL";
  is_active: boolean;
};
export type ActiveItemMasterData = { items: ActiveItemOption[]; errors: MasterDataReadError[] };
export type ActiveInstitutionMasterData = { institutions: ActiveInstitutionOption[]; errors: MasterDataReadError[] };
export type ActiveWarehouseMasterData = { warehouses: ActiveWarehouseOption[]; errors: MasterDataReadError[] };

type CacheKey = "organization" | "product" | "procurement" | "employee" | "active-employees" | "hr-request" | "active-items" | "active-institutions" | "active-warehouses";
type CacheEntry = { loadedAt: number; promise: Promise<unknown> };

// Projection entries are derived from their full source snapshots. Keep that
// dependency graph here so every caller gets the same invalidation semantics
// instead of having to remember which sibling keys to clear after a mutation.
const INVALIDATION_KEYS: Record<CacheKey, readonly CacheKey[]> = {
  organization: ["organization", "active-institutions", "hr-request"],
  product: ["product", "procurement", "active-items", "hr-request"],
  procurement: ["procurement"],
  employee: ["employee", "active-employees", "hr-request"],
  "active-employees": ["active-employees"],
  "hr-request": ["hr-request"],
  "active-items": ["active-items"],
  "active-institutions": ["active-institutions"],
  "active-warehouses": ["active-warehouses"],
};

const cacheByClient = new WeakMap<SupabaseClient, Map<CacheKey, CacheEntry>>();
const CACHE_TTL_MS = 30_000;
type HrOptionView = "employee" | "item";
type HrOptionSchemaGap = "employee-view" | "item-view" | "employee-join";
const missingHrSchemaGapsByClient = new WeakMap<SupabaseClient, Map<HrOptionSchemaGap, number>>();

type HrItemAvailabilitySourceRow = {
  item_id: string;
  item_code: string;
  item_name: string;
  size: string | null;
  unit: string;
  is_active: boolean;
  hr_on_hand_quantity: number;
  general_on_hand_quantity: number;
  active_reserved_quantity: number;
};

function cacheFor(client: SupabaseClient): Map<CacheKey, CacheEntry> {
  const current = cacheByClient.get(client);
  if (current) return current;
  const next = new Map<CacheKey, CacheEntry>();
  cacheByClient.set(client, next);
  return next;
}

function missingHrSchemaGapsFor(client: SupabaseClient): Map<HrOptionSchemaGap, number> {
  const current = missingHrSchemaGapsByClient.get(client);
  if (current) return current;
  const next = new Map<HrOptionSchemaGap, number>();
  missingHrSchemaGapsByClient.set(client, next);
  return next;
}

function isKnownMissingHrSchemaGap(client: SupabaseClient, gap: HrOptionSchemaGap): boolean {
  const missingUntil = missingHrSchemaGapsFor(client).get(gap);
  if (missingUntil === undefined) return false;
  if (Date.now() < missingUntil) return true;
  missingHrSchemaGapsFor(client).delete(gap);
  return false;
}

function rememberMissingHrSchemaGap(client: SupabaseClient, gap: HrOptionSchemaGap): void {
  missingHrSchemaGapsFor(client).set(gap, Date.now() + MISSING_READ_MODEL_CACHE_TTL_MS);
}

function isKnownMissingHrOptionView(
  client: SupabaseClient,
  view: HrOptionView,
): boolean {
  return isKnownMissingHrSchemaGap(client, `${view}-view`);
}

function isMissingHrOptionViewError(
  error: { code?: string | null; message?: string | null } | null,
  viewName: string,
): boolean {
  if (!error || (error.code !== "PGRST205" && error.code !== "42P01")) return false;
  return (error.message ?? "").toLocaleLowerCase().includes(viewName.toLocaleLowerCase());
}

function rememberMissingHrOptionView(client: SupabaseClient, view: HrOptionView): void {
  rememberMissingHrSchemaGap(client, `${view}-view`);
}

function readError(resource: MasterDataReadError["resource"], error: { code?: string | null; message?: string | null } | null): MasterDataReadError | null {
  return error ? { resource, code: error.code, message: error.message ?? "資料讀取失敗" } : null;
}

const HR_REQUEST_READ_RESOURCE_LABELS: Record<MasterDataReadError["resource"], string> = {
  institutions: "機構",
  departments: "部門",
  uniform_items: "制服品號／庫存",
  suppliers: "供應商",
  supplier_uniform_items: "供應條件",
  procurement_difference_reasons: "採購差異原因",
  employees: "員工主檔",
  warehouses: "倉庫",
};

export function safeHrRequestMasterDataErrorMessage(errors: readonly MasterDataReadError[]): string {
  const diagnostics = [...new Set(errors.map((error) => {
    const code = error.code && (/^PGRST\d{3}$/.test(error.code) || /^[0-9A-Z]{5}$/.test(error.code))
      ? error.code
      : "未知代碼";
    return `${HR_REQUEST_READ_RESOURCE_LABELS[error.resource]}：${code}`;
  }))];
  const detail = diagnostics.length > 0 ? `（${diagnostics.join("、")}）` : "";
  return `正式主檔讀取失敗${detail}，已暫停送出；請將代碼提供給系統管理員。已填資料會保留。`;
}

function cached<T>(client: SupabaseClient, key: CacheKey, load: () => Promise<{ value: T; cacheable: boolean }>): Promise<T> {
  const cache = cacheFor(client);
  const existing = cache.get(key);
  if (existing && Date.now() - existing.loadedAt < CACHE_TTL_MS) return existing.promise as Promise<T>;

  const promise = load().then(({ value, cacheable }) => {
    if (cache.get(key)?.promise !== promise) return value;
    if (cacheable) cache.set(key, { loadedAt: Date.now(), promise });
    else cache.delete(key);
    return value;
  }).catch((error) => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw error;
  });
  cache.set(key, { loadedAt: Date.now(), promise });
  return promise;
}

function freshCached<T>(client: SupabaseClient, key: CacheKey): Promise<T> | null {
  const entry = cacheFor(client).get(key);
  if (!entry || Date.now() - entry.loadedAt >= CACHE_TTL_MS) return null;
  return entry.promise as Promise<T>;
}

function errorsForResources(errors: MasterDataReadError[], resources: readonly MasterDataReadError["resource"][]): MasterDataReadError[] {
  return errors.filter((error) => resources.includes(error.resource));
}

export function loadOrganizationMasterData(client: SupabaseClient): Promise<OrganizationMasterData> {
  return cached(client, "organization", async () => {
    const [institutionResult, departmentResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      () => Promise.all([
        client.from("institutions").select("id,code,name,is_active").order("code").limit(1000),
        client.from("departments").select("id,institution_id,code,name,is_active").order("code").limit(5000),
      ]),
    );
    const errors = [
      readError("institutions", institutionResult.error),
      readError("departments", departmentResult.error),
    ].filter((error): error is MasterDataReadError => Boolean(error));
    return {
      value: {
        institutions: (institutionResult.data ?? []) as MasterDataInstitution[],
        departments: (departmentResult.data ?? []) as MasterDataDepartment[],
        errors,
      },
      cacheable: errors.length === 0,
    };
  });
}

export function loadProductMasterData(client: SupabaseClient): Promise<ProductMasterData> {
  return cached(client, "product", async () => {
    const [itemResult, supplierResult, relationResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      () => Promise.all([
        client.from("uniform_items").select("id,item_code,item_name,unit,size,category,season,is_active").order("item_code").limit(1000),
        client.from("suppliers").select("id,supplier_code,name,default_currency,is_active").order("supplier_code").limit(1000),
        client.from("supplier_uniform_items").select("item_id,supplier_id,minimum_order_quantity,supplier_item_code,is_active").eq("is_active", true).limit(5000),
      ]),
    );
    const errors = [
      readError("uniform_items", itemResult.error),
      readError("suppliers", supplierResult.error),
      readError("supplier_uniform_items", relationResult.error),
    ].filter((error): error is MasterDataReadError => Boolean(error));
    return {
      value: {
        items: (itemResult.data ?? []) as MasterDataItem[],
        suppliers: (supplierResult.data ?? []) as MasterDataSupplier[],
        supplierItems: (relationResult.data ?? []) as MasterDataSupplierItem[],
        errors,
      },
      cacheable: errors.length === 0,
    };
  });
}

export function loadProcurementMasterData(client: SupabaseClient): Promise<ProcurementMasterData> {
  return cached(client, "procurement", async () => {
    const productSnapshot = freshCached<ProductMasterData>(client, "product");
    if (productSnapshot) {
      const [source, reasonResult] = await Promise.all([
        productSnapshot,
        retrySupabaseQueriesAfterSessionRefresh(
          client,
          async () => [await client
            .from("procurement_difference_reasons")
            .select("code,name")
            .eq("is_active", true)
            .order("code")
            .limit(500)] as const,
        ).then(([result]) => result),
      ]);
      const errors = [
        ...errorsForResources(source.errors, ["suppliers", "supplier_uniform_items"]),
        readError("procurement_difference_reasons", reasonResult.error),
      ].filter((error): error is MasterDataReadError => Boolean(error));
      return {
        value: {
          suppliers: source.suppliers
            .filter((supplier) => supplier.is_active)
            .map(({ id, supplier_code, name, default_currency }) => ({ id, supplier_code, name, default_currency })),
          supplierItems: source.supplierItems
            .filter((relation) => relation.is_active)
            .map(({ item_id, supplier_id, minimum_order_quantity }) => ({ item_id, supplier_id, minimum_order_quantity })),
          differenceReasons: (reasonResult.data ?? []) as ProcurementDifferenceReasonOption[],
          errors,
        },
        cacheable: errors.length === 0,
      };
    }
    const [supplierResult, relationResult, reasonResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      () => Promise.all([
        client.from("suppliers")
          .select("id,supplier_code,name,default_currency")
          .eq("is_active", true)
          .order("supplier_code")
          .limit(1000),
        client.from("supplier_uniform_items")
          .select("supplier_id,item_id,minimum_order_quantity")
          .eq("is_active", true)
          .limit(5000),
        client.from("procurement_difference_reasons")
          .select("code,name")
          .eq("is_active", true)
          .order("code")
          .limit(500),
      ]),
    );
    const errors = [
      readError("suppliers", supplierResult.error),
      readError("supplier_uniform_items", relationResult.error),
      readError("procurement_difference_reasons", reasonResult.error),
    ].filter((error): error is MasterDataReadError => Boolean(error));
    return {
      value: {
        suppliers: (supplierResult.data ?? []) as ProcurementSupplierOption[],
        supplierItems: (relationResult.data ?? []) as ProcurementSupplierItemOption[],
        differenceReasons: (reasonResult.data ?? []) as ProcurementDifferenceReasonOption[],
        errors,
      },
      cacheable: errors.length === 0,
    };
  });
}

export function loadEmployeeMasterData(client: SupabaseClient): Promise<EmployeeMasterData> {
  return cached(client, "employee", async () => {
    const [employeeResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client
        .from("employees")
        .select("id,employee_no,name,institution_id,department_id,employment_status,job_title,hire_date,termination_date,note")
        .order("employee_no")
        .limit(10000)] as const,
    );
    const errors = [readError("employees", employeeResult.error)]
      .filter((error): error is MasterDataReadError => Boolean(error));
    return {
      value: {
        employees: (employeeResult.data ?? []) as MasterDataEmployee[],
        errors,
      },
      cacheable: errors.length === 0,
    };
  });
}

export function loadActiveEmployeeOptions(client: SupabaseClient): Promise<ActiveEmployeeMasterData> {
  return cached(client, "active-employees", async () => {
    const employeeSnapshot = freshCached<EmployeeMasterData>(client, "employee");
    if (employeeSnapshot) {
      const source = await employeeSnapshot;
      const errors = errorsForResources(source.errors, ["employees"]);
      return {
        value: {
          employees: source.employees
            .filter((employee) => employee.employment_status === "ACTIVE")
            .map(({ id, employee_no, name, institution_id, department_id }) => ({ id, employee_no, name, institution_id, department_id })),
          errors,
        },
        cacheable: errors.length === 0,
      };
    }
    const [employeeResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client
        .from("employees")
        .select("id,employee_no,name,institution_id,department_id")
        .eq("employment_status", "ACTIVE")
        .order("employee_no")
        .limit(10000)] as const,
    );
    const errors = [readError("employees", employeeResult.error)]
      .filter((error): error is MasterDataReadError => Boolean(error));
    return {
      value: {
        employees: (employeeResult.data ?? []) as ActiveEmployeeOption[],
        errors,
      },
      cacheable: errors.length === 0,
    };
  });
}

export function loadActiveItemOptions(client: SupabaseClient): Promise<ActiveItemMasterData> {
  return cached(client, "active-items", async () => {
    const productSnapshot = freshCached<ProductMasterData>(client, "product");
    if (productSnapshot) {
      const source = await productSnapshot;
      const errors = errorsForResources(source.errors, ["uniform_items"]);
      return {
        value: {
          items: source.items
            .filter((item) => item.is_active)
            .map(({ id, item_code, item_name, unit, size }) => ({ id, item_code, item_name, unit, size })),
          errors,
        },
        cacheable: errors.length === 0,
      };
    }
    const [itemResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client.from("uniform_items").select("id,item_code,item_name,unit,size").eq("is_active", true).order("item_code").limit(10000)] as const,
    );
    const errors = [readError("uniform_items", itemResult.error)]
      .filter((error): error is MasterDataReadError => Boolean(error));
    return {
      value: { items: (itemResult.data ?? []) as ActiveItemOption[], errors },
      cacheable: errors.length === 0,
    };
  });
}

export function loadActiveInstitutionOptions(client: SupabaseClient): Promise<ActiveInstitutionMasterData> {
  return cached(client, "active-institutions", async () => {
    const organizationSnapshot = freshCached<OrganizationMasterData>(client, "organization");
    if (organizationSnapshot) {
      const source = await organizationSnapshot;
      const errors = errorsForResources(source.errors, ["institutions"]);
      return {
        value: {
          institutions: source.institutions
            .filter((institution) => institution.is_active)
            .map(({ id, code, name }) => ({ id, code, name })),
          errors,
        },
        cacheable: errors.length === 0,
      };
    }
    const [institutionResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client.from("institutions").select("id,code,name").eq("is_active", true).order("code").limit(1000)] as const,
    );
    const errors = [readError("institutions", institutionResult.error)]
      .filter((error): error is MasterDataReadError => Boolean(error));
    return {
      value: { institutions: (institutionResult.data ?? []) as ActiveInstitutionOption[], errors },
      cacheable: errors.length === 0,
    };
  });
}

export function loadActiveWarehouseOptions(client: SupabaseClient): Promise<ActiveWarehouseMasterData> {
  return cached(client, "active-warehouses", async () => {
    const [warehouseResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client.from("warehouses").select("id,code,name,purpose").eq("is_active", true).order("purpose").limit(100)] as const,
    );
    const errors = [readError("warehouses", warehouseResult.error)]
      .filter((error): error is MasterDataReadError => Boolean(error));
    return {
      value: { warehouses: (warehouseResult.data ?? []) as ActiveWarehouseOption[], errors },
      cacheable: errors.length === 0,
    };
  });
}

async function loadLegacyHrEmployeeOptionsWithSeparateReads(client: SupabaseClient): Promise<{
  employees: HrEmployeeOptionSourceRow[];
  errors: MasterDataReadError[];
}> {
  const [employeeResult, institutionResult, departmentResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    () => Promise.all([
      client.from("employees")
        .select("id,employee_no,name,institution_id,department_id,employment_status")
        .eq("employment_status", "ACTIVE")
        .order("employee_no")
        .limit(10000),
      client.from("institutions")
        .select("id,code,name,is_active")
        .eq("is_active", true)
        .order("code")
        .limit(1000),
      client.from("departments")
        .select("id,institution_id,code,name,is_active")
        .eq("is_active", true)
        .order("code")
        .limit(5000),
    ]),
  );
  const errors = [
    readError("employees", employeeResult.error),
    readError("institutions", institutionResult.error),
    readError("departments", departmentResult.error),
  ].filter((error): error is MasterDataReadError => Boolean(error));

  if (errors.length > 0) return { employees: [], errors };
  return {
    employees: buildHrEmployeeOptionRowsFromMasterData(
      (employeeResult.data ?? []) as HrEmployeeMasterSourceRow[],
      (institutionResult.data ?? []) as HrInstitutionOptionSourceRow[],
      (departmentResult.data ?? []) as HrDepartmentOptionSourceRow[],
    ),
    errors,
  };
}

async function loadLegacyHrEmployeeOptions(client: SupabaseClient): Promise<{
  employees: HrEmployeeOptionSourceRow[];
  errors: MasterDataReadError[];
}> {
  if (isKnownMissingHrSchemaGap(client, "employee-join")) {
    return loadLegacyHrEmployeeOptionsWithSeparateReads(client);
  }

  const [employeeResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("employees")
      .select("id,employee_no,name,institution_id,department_id,employment_status,institution:institutions!employees_institution_id_fkey(id,code,name,is_active),department:departments!employees_department_id_institution_id_fkey(id,institution_id,code,name,is_active)")
      .eq("employment_status", "ACTIVE")
      .order("employee_no")
      .limit(10000)] as const,
  );
  if (employeeResult.error) {
    if (employeeResult.error.code === "PGRST200" || employeeResult.error.code === "PGRST201") {
      // Relationship metadata is schema-scoped too; do not repeat a known
      // failing embedded read every time the short-lived data cache expires.
      rememberMissingHrSchemaGap(client, "employee-join");
      return loadLegacyHrEmployeeOptionsWithSeparateReads(client);
    }
    const error = readError("employees", employeeResult.error);
    return { employees: [], errors: error ? [error] : [] };
  }
  return {
    employees: buildHrEmployeeOptionRowsFromJoinedData(
      (employeeResult.data ?? []) as HrEmployeeJoinedOptionSourceRow[],
    ),
    errors: [],
  };
}

async function loadLegacyHrItemOptions(client: SupabaseClient): Promise<{
  items: HrRequestItemOption[];
  errors: MasterDataReadError[];
}> {
  const [availabilityResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("v_item_availability")
      .select("item_id,item_code,item_name,size,unit,is_active,hr_on_hand_quantity,general_on_hand_quantity,active_reserved_quantity")
      .eq("is_active", true)
      .order("item_code")
      .limit(10000)] as const,
  );
  const errors = [readError("uniform_items", availabilityResult.error)]
    .filter((error): error is MasterDataReadError => Boolean(error));
  if (errors.length > 0) return { items: [], errors };
  return {
    items: ((availabilityResult.data ?? []) as HrItemAvailabilitySourceRow[])
      .filter((item) => item.is_active)
      .map(({ item_id, item_code, item_name, size, unit, hr_on_hand_quantity, general_on_hand_quantity, active_reserved_quantity }) => ({
        id: item_id,
        item_code,
        item_name,
        size,
        unit,
        hr_on_hand_quantity,
        general_on_hand_quantity,
        active_reserved_quantity,
      })),
    errors,
  };
}

/**
 * Read the two server-shaped option lists needed by the HR request form as one
 * cache entry. Prefer migration 0104's views; when a view is explicitly absent,
 * fall back to the same RLS-protected source tables and existing availability
 * view. The submit RPC remains authoritative and rechecks under lock.
 */
export function loadHrRequestMasterData(client: SupabaseClient): Promise<HrRequestMasterData> {
  return cached(client, "hr-request", async () => {
    const skipEmployeeView = isKnownMissingHrOptionView(client, "employee");
    const skipItemView = isKnownMissingHrOptionView(client, "item");
    const [employeeResult, itemResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      () => Promise.all([
        skipEmployeeView
          ? Promise.resolve({ data: null, error: null })
          : client.from("v_hr_request_employee_options")
            .select("id,employee_no,name,institution_id,institution_code,institution_name,department_id,department_code,department_name")
            .order("employee_no")
            .limit(10000),
        skipItemView
          ? Promise.resolve({ data: null, error: null })
          : client.from("v_hr_request_item_options")
            .select("id,item_code,item_name,size,unit,hr_on_hand_quantity,general_on_hand_quantity,active_reserved_quantity")
            .order("item_code")
            .limit(10000),
      ]),
    );
    const employeeViewMissing = skipEmployeeView
      || isMissingHrOptionViewError(employeeResult.error, "v_hr_request_employee_options");
    const itemViewMissing = skipItemView
      || isMissingHrOptionViewError(itemResult.error, "v_hr_request_item_options");
    if (!skipEmployeeView && employeeViewMissing) rememberMissingHrOptionView(client, "employee");
    if (!skipItemView && itemViewMissing) rememberMissingHrOptionView(client, "item");

    const [legacyEmployees, legacyItems] = await Promise.all([
      employeeViewMissing ? loadLegacyHrEmployeeOptions(client) : null,
      itemViewMissing ? loadLegacyHrItemOptions(client) : null,
    ]);
    const errors = [
      ...(employeeViewMissing
        ? legacyEmployees?.errors ?? []
        : [readError("employees", employeeResult.error)]),
      ...(itemViewMissing
        ? legacyItems?.errors ?? []
        : [readError("uniform_items", itemResult.error)]),
    ].filter((error): error is MasterDataReadError => Boolean(error));
    return {
      value: {
        employees: employeeViewMissing
          ? legacyEmployees?.employees ?? []
          : (employeeResult.data ?? []) as HrEmployeeOptionSourceRow[],
        items: itemViewMissing
          ? legacyItems?.items ?? []
          : (itemResult.data ?? []) as HrRequestItemOption[],
        errors,
      },
      cacheable: errors.length === 0,
    };
  });
}

export function invalidateMasterDataCache(client: SupabaseClient, key?: CacheKey): void {
  if (key) {
    const cache = cacheFor(client);
    for (const invalidationKey of INVALIDATION_KEYS[key]) cache.delete(invalidationKey);
    return;
  }
  cacheByClient.delete(client);
  missingHrSchemaGapsByClient.delete(client);
}
