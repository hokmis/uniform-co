import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { invalidateEmployeeDirectory, loadEmployeeDirectory } from "./employee-directory-read";

function queryBuilder(result: unknown) {
  const builder = {
    select: vi.fn(() => builder),
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

describe("employee directory read adapter", () => {
  it("maps employee and organization snapshots through one read", async () => {
    const view = queryBuilder({
      data: [{
        id: "employee-1",
        employee_no: "E001",
        name: "王小明",
        institution_id: "institution-1",
        institution_code: "A",
        institution_name: "清福",
        department_id: "department-1",
        department_code: "HR",
        department_name: "人資",
        employment_status: "ACTIVE",
        job_title: "專員",
        hire_date: "2026-01-01",
        termination_date: null,
        note: null,
      }],
      error: null,
    });
    const client = clientFrom({ v_employee_directory: view });

    await expect(loadEmployeeDirectory(client)).resolves.toEqual({
      employees: [{
        id: "employee-1",
        employee_no: "E001",
        name: "王小明",
        institution_id: "institution-1",
        institution_code: "A",
        institution_name: "清福",
        department_id: "department-1",
        department_code: "HR",
        department_name: "人資",
        employment_status: "ACTIVE",
        job_title: "專員",
        hire_date: "2026-01-01",
        termination_date: null,
        note: null,
      }],
      errors: [],
      usedLegacyFallback: false,
    });
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(view.select).toHaveBeenCalledWith("id,employee_no,name,institution_id,institution_code,institution_name,department_id,department_code,department_name,employment_status,job_title,hire_date,termination_date,note");
  });

  it("falls back to the cached legacy reads during a rolling migration", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    const employees = queryBuilder({
      data: [{
        id: "employee-2", employee_no: "E002", name: "李小華", institution_id: "institution-2", department_id: "department-2",
        employment_status: "INACTIVE", job_title: null, hire_date: null, termination_date: "2026-02-01", note: null,
      }],
      error: null,
    });
    const institutions = queryBuilder({ data: [{ id: "institution-2", code: "B", name: "清氣", is_active: false }], error: null });
    const departments = queryBuilder({ data: [{ id: "department-2", institution_id: "institution-2", code: "OPS", name: "營運", is_active: false }], error: null });
    const client = clientFrom({ v_employee_directory: view, employees, institutions, departments });

    const result = await loadEmployeeDirectory(client);

    expect(result).toEqual({
      employees: [{
        id: "employee-2", employee_no: "E002", name: "李小華", institution_id: "institution-2", department_id: "department-2",
        employment_status: "INACTIVE", job_title: null, hire_date: null, termination_date: "2026-02-01", note: null,
        institution_code: "B", institution_name: "清氣", department_code: "OPS", department_name: "營運",
      }],
      errors: [],
      usedLegacyFallback: true,
    });
    expect(client.from).toHaveBeenCalledWith("employees");
    expect(client.from).toHaveBeenCalledWith("institutions");
    expect(client.from).toHaveBeenCalledWith("departments");
  });

  it("does not hide permission failures behind the rollout fallback", async () => {
    const view = queryBuilder({ data: null, error: { code: "42501", message: "permission denied" } });
    const client = clientFrom({ v_employee_directory: view });

    const result = await loadEmployeeDirectory(client);

    expect(result.errors).toMatchObject([{ resource: "employees", code: "42501" }]);
    expect(result.usedLegacyFallback).toBe(false);
    expect(client.from).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent reads and invalidates after a write", async () => {
    const view = queryBuilder({ data: [], error: null });
    const client = clientFrom({ v_employee_directory: view });

    await Promise.all([loadEmployeeDirectory(client), loadEmployeeDirectory(client)]);
    expect(client.from).toHaveBeenCalledTimes(1);

    invalidateEmployeeDirectory(client);
    await loadEmployeeDirectory(client);
    expect(client.from).toHaveBeenCalledTimes(2);
  });
});
