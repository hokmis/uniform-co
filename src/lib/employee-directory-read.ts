import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadEmployeeMasterData,
  loadOrganizationMasterData,
  type MasterDataEmployee,
  type MasterDataReadError,
} from "./master-data-cache";
import { retrySupabaseQueriesAfterSessionRefresh, type SupabaseSessionError } from "./supabase-session";
import { shouldProbeReadModel, shouldUseLegacyReadModel } from "./read-model-rollout";

export type EmployeeDirectoryRow = MasterDataEmployee & {
  institution_code: string | null;
  institution_name: string | null;
  department_code: string | null;
  department_name: string | null;
};

export type EmployeeDirectoryReadResult = {
  employees: EmployeeDirectoryRow[];
  errors: MasterDataReadError[];
  usedLegacyFallback: boolean;
};

type EmployeeDirectoryCacheEntry = {
  loadedAt: number;
  promise: Promise<EmployeeDirectoryReadResult>;
};

const directoryCacheByClient = new WeakMap<SupabaseClient, EmployeeDirectoryCacheEntry>();
const EMPLOYEE_DIRECTORY_CACHE_TTL_MS = 30_000;

const viewSelect = "id,employee_no,name,institution_id,institution_code,institution_name,department_id,department_code,department_name,employment_status,job_title,hire_date,termination_date,note";

function readError(error: SupabaseSessionError | null): MasterDataReadError {
  return {
    resource: "employees",
    code: error?.code,
    message: error?.message ?? "員工目錄讀取失敗",
  };
}

function mapViewRows(rows: unknown[]): EmployeeDirectoryRow[] {
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    employee_no: String(row.employee_no ?? ""),
    name: String(row.name ?? ""),
    institution_id: String(row.institution_id),
    institution_code: typeof row.institution_code === "string" ? row.institution_code : null,
    institution_name: typeof row.institution_name === "string" ? row.institution_name : null,
    department_id: String(row.department_id),
    department_code: typeof row.department_code === "string" ? row.department_code : null,
    department_name: typeof row.department_name === "string" ? row.department_name : null,
    employment_status: row.employment_status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    job_title: typeof row.job_title === "string" ? row.job_title : null,
    hire_date: typeof row.hire_date === "string" ? row.hire_date : null,
    termination_date: typeof row.termination_date === "string" ? row.termination_date : null,
    note: typeof row.note === "string" ? row.note : null,
  }));
}

async function loadLegacyDirectory(client: SupabaseClient): Promise<EmployeeDirectoryReadResult> {
  const [employeeResult, organizationResult] = await Promise.all([
    loadEmployeeMasterData(client),
    loadOrganizationMasterData(client),
  ]);
  const institutionById = new Map(organizationResult.institutions.map((row) => [row.id, row]));
  const departmentById = new Map(organizationResult.departments.map((row) => [row.id, row]));
  const employees = employeeResult.employees.map((employee) => {
    const institution = institutionById.get(employee.institution_id);
    const department = departmentById.get(employee.department_id);
    return {
      ...employee,
      institution_code: institution?.code ?? null,
      institution_name: institution?.name ?? null,
      department_code: department?.code ?? null,
      department_name: department?.name ?? null,
    };
  });
  return {
    employees,
    errors: [...employeeResult.errors, ...organizationResult.errors],
    usedLegacyFallback: true,
  };
}

/**
 * Reads the employee directory with organization snapshots in one request.
 * The legacy employee + organization reads remain only while 0120 rolls out;
 * a real permission or schema error is never hidden by that fallback.
 */
async function readEmployeeDirectory(client: SupabaseClient): Promise<EmployeeDirectoryReadResult> {
  const viewName = "v_employee_directory";
  if (!shouldProbeReadModel(client, viewName)) return loadLegacyDirectory(client);

  const [viewResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("v_employee_directory")
      .select(viewSelect)
      .order("employee_no")
      .limit(10000)] as const,
  );
  const useLegacyFallback = shouldUseLegacyReadModel(client, viewName, viewResult.error);
  if (!viewResult.error) {
    return { employees: mapViewRows(viewResult.data ?? []), errors: [], usedLegacyFallback: false };
  }
  if (!useLegacyFallback) {
    return { employees: [], errors: [readError(viewResult.error)], usedLegacyFallback: false };
  }
  return loadLegacyDirectory(client);
}

/**
 * Shares one employee-directory read between the list and import panels.
 * Writes explicitly invalidate this short-lived snapshot; errors are never cached.
 */
export function loadEmployeeDirectory(client: SupabaseClient): Promise<EmployeeDirectoryReadResult> {
  const existing = directoryCacheByClient.get(client);
  if (existing && Date.now() - existing.loadedAt < EMPLOYEE_DIRECTORY_CACHE_TTL_MS) return existing.promise;

  const promise = readEmployeeDirectory(client).then((result) => {
    if (directoryCacheByClient.get(client)?.promise !== promise) return result;
    if (result.errors.length === 0) directoryCacheByClient.set(client, { loadedAt: Date.now(), promise });
    else directoryCacheByClient.delete(client);
    return result;
  }).catch((error) => {
    if (directoryCacheByClient.get(client)?.promise === promise) directoryCacheByClient.delete(client);
    throw error;
  });
  directoryCacheByClient.set(client, { loadedAt: Date.now(), promise });
  return promise;
}

export function invalidateEmployeeDirectory(client: SupabaseClient): void {
  directoryCacheByClient.delete(client);
}
