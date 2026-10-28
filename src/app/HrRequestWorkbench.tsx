"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  HrRequestValidationError,
  inspectHrRequest,
  summarizeHrRequest,
  type EmployeeSnapshot,
  type IssueLineDraft,
  type UniformItemSnapshot,
} from "@/src/domain/hr-request";
import { buildActiveHrEmployeeOptions } from "@/src/domain/hr-employee-options";
import {
  createHrRequestOperation,
  preserveHrRequestDraftLines,
  preserveHrRequestIncreaseDraft,
  resolveHrRequestSubmissionRoute,
  rotateHrRequestDraftKeys,
  type HrRequestEntryState,
  type HrRequestLineSelection,
  type HrRequestOperation,
} from "@/src/domain/hr-request-workflow";
import { hrRequestWorkflowChangedEvent } from "@/src/domain/hr-request-events";
import {
  submitHrRequestOperation,
  type HrRequestSubmissionInput,
} from "@/src/domain/hr-request-submission";
import { inventoryDataChangedEvent } from "@/src/domain/inventory-events";
import { shouldPreserveReadSnapshot, staleReadSnapshotMessage } from "@/src/domain/read-refresh";
import { invalidateMasterDataCache, loadHrRequestMasterData, loadOrganizationMasterData, safeHrRequestMasterDataErrorMessage } from "@/src/lib/master-data-cache";
import { isSupabaseSessionSyncError, retrySupabaseQueriesAfterSessionRefresh, retrySupabaseRpcAfterSessionRefresh, safeSupabaseMutationErrorMessage } from "@/src/lib/supabase-session";
import {
  HR_REQUEST_ALLOWED_DEPARTMENTS,
  resolveInstitutionInfo,
} from "@/src/domain/hr-request-pivot-export";
import {
  STANDARD_UNIFORM_SIZES,
  extractUniformSize,
  compareUniformItems,
} from "@/src/domain/uniform-size";
import { autoBalanceIssueAndIncreaseLines } from "@/src/domain/hr-request-auto-balance";
import { useWorkspaceSession } from "./workspace-session";
import { usePanelActivity } from "./RetainedPanelSet";
import ReturnedHrRequestPicker from "./ReturnedHrRequestPicker";

type LineState = HrRequestLineSelection & {
  departmentCode?: string;
};

type DepartmentOption = { code: string; name: string };

function findEmployeeForDepartment(employees: EmployeeSnapshot[], deptCode?: string): EmployeeSnapshot | undefined {
  if (!deptCode || employees.length === 0) return undefined;
  const direct = employees.find((emp) => emp.institutionCode === deptCode || emp.departmentCode === deptCode);
  if (direct) return direct;
  const targetInfo = resolveInstitutionInfo(deptCode);
  return employees.find((emp) => {
    const instInfo = resolveInstitutionInfo(emp.institutionCode || emp.institutionName);
    const deptInfo = resolveInstitutionInfo(emp.departmentCode || emp.departmentName);
    return (instInfo.shortName && instInfo.shortName !== "其他" && instInfo.shortName === targetInfo.shortName)
      || (deptInfo.shortName && deptInfo.shortName !== "其他" && deptInfo.shortName === targetInfo.shortName);
  });
}

type UniformCategoryKey = "ALL" | "照服" | "護士" | "行政" | "廚師" | "工務" | "幼兒園" | "OTHER";
type GenderFilterKey = "ALL" | "MALE" | "FEMALE";
type SeasonFilterKey = "ALL" | "SUMMER" | "WINTER";

function getUniformCategory(itemName: string, itemCode: string): UniformCategoryKey {
  const name = itemName || "";
  const code = itemCode || "";
  if (name.includes("照服") || code.includes("照服")) return "照服";
  if (name.includes("護士") || code.includes("護士")) return "護士";
  if (name.includes("行政") || code.includes("行政")) return "行政";
  if (name.includes("廚師") || code.includes("廚師")) return "廚師";
  if (name.includes("工務") || code.includes("工務")) return "工務";
  if (name.includes("幼兒園") || name.includes("幼") || code.includes("幼")) return "幼兒園";
  return "OTHER";
}

function getUniformGender(itemName: string, size?: string): "MALE" | "FEMALE" | "NEUTRAL" {
  const s = size ? size.trim() : "";
  const name = itemName ? itemName.trim() : "";

  const sHasMale = s.includes("男");
  const sHasFemale = s.includes("女");
  if (sHasMale && !sHasFemale) return "MALE";
  if (sHasFemale && !sHasMale) return "FEMALE";

  const nameHasMale = name.includes("男");
  const nameHasFemale = name.includes("女");
  if (nameHasMale && !nameHasFemale) return "MALE";
  if (nameHasFemale && !nameHasMale) return "FEMALE";

  return "NEUTRAL";
}

function getUniformSeason(itemName: string): "SUMMER" | "WINTER" | "ALL_SEASON" | "NONE" {
  const name = itemName ? itemName.trim() : "";
  const hasSummer = name.includes("夏");
  const hasWinter = name.includes("冬");

  if (hasSummer && hasWinter) return "ALL_SEASON";
  if (hasSummer) return "SUMMER";
  if (hasWinter) return "WINTER";
  return "NONE";
}

export const DEPARTMENT_BUTTON_ROWS: { code: string; name: string; display: string }[][] = [
  [
    { code: "C8", name: "福", display: "福" },
    { code: "C7", name: "氣", display: "氣" },
    { code: "C6", name: "心", display: "心" },
    { code: "C5", name: "平", display: "平" },
    { code: "C3", name: "安", display: "安" },
    { code: "D8", name: "春", display: "春" },
    { code: "D7", name: "日", display: "日" },
    { code: "D6", name: "照", display: "照" },
    { code: "D5", name: "風", display: "風" },
    { code: "D3", name: "景", display: "景" },
    { code: "E8", name: "山", display: "山" },
    { code: "E7", name: "泉", display: "泉" },
    { code: "E6", name: "水", display: "水" },
    { code: "E5", name: "清", display: "清" },
    { code: "E3", name: "涼", display: "涼" },
    { code: "CD2", name: "護家", display: "護家" },
    { code: "47091980", name: "含笑", display: "含笑" },
  ],
  [
    { code: "L1", name: "法人", display: "法人" },
    { code: "L67", name: "一館", display: "一館" },
    { code: "L5", name: "二館", display: "二館" },
    { code: "L23", name: "三館", display: "三館" },
    { code: "B2", name: "幼", display: "幼兒園" },
  ],
];

const previewEmployees: EmployeeSnapshot[] = [
  {
    employeeId: "employee-1",
    employeeNo: "E001",
    employeeName: "測試員工一",
    institutionCode: "C8",
    institutionName: "福",
    departmentCode: "C8",
    departmentName: "福",
  },
  {
    employeeId: "employee-2",
    employeeNo: "E002",
    employeeName: "測試員工二",
    institutionCode: "C7",
    institutionName: "氣",
    departmentCode: "C7",
    departmentName: "氣",
  },
];

const previewDepartments: DepartmentOption[] = HR_REQUEST_ALLOWED_DEPARTMENTS;

const previewItems: UniformItemSnapshot[] = [
  {
    itemId: "item-m",
    itemCode: "U-M",
    itemName: "測試上衣",
    size: "M",
    unit: "件",
    hrOnHand: 10,
    generalOnHand: 5,
    activeReserved: 0,
  },
  {
    itemId: "item-l",
    itemCode: "U-L",
    itemName: "測試長褲",
    size: "L",
    unit: "件",
    hrOnHand: 20,
    generalOnHand: 100,
    activeReserved: 0,
  },
];

const previewLines: LineState[] = [
  { lineId: "line-1", employeeId: "employee-1", itemId: "item-m", quantity: 10, departmentCode: "C8" },
];

function taipeiToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

export default function HrRequestWorkbench() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const previewMode = !client;
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeSnapshot[]>(previewMode ? previewEmployees : []);
  const [departmentOptions, setDepartmentOptions] = useState<DepartmentOption[]>(previewMode ? previewDepartments : []);
  const [itemOptions, setItemOptions] = useState<UniformItemSnapshot[]>(previewMode ? previewItems : []);
  const [lines, setLines] = useState<LineState[]>(previewMode ? previewLines : []);
  const [distributionDate, setDistributionDate] = useState(taipeiToday());
  const [requestNote, setRequestNote] = useState("");
  const [increases, setIncreases] = useState<Record<string, number>>(
    previewMode ? { "item-m": 0, "item-l": 0 } : {},
  );
  const [increasePage, setIncreasePage] = useState(1);
  const [increaseSearch, setIncreaseSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<UniformCategoryKey>("ALL");
  const [genderFilter, setGenderFilter] = useState<GenderFilterKey>("ALL");
  const [seasonFilter, setSeasonFilter] = useState<SeasonFilterKey>("ALL");
  const [sizeFilter, setSizeFilter] = useState<string>("ALL");
  const [selectedDeptCode, setSelectedDeptCode] = useState<string>("C8");
  const [issuePage, setIssuePage] = useState(1);
  const [issueSearch, setIssueSearch] = useState("");
  const [issueCategoryFilter, setIssueCategoryFilter] = useState<UniformCategoryKey>("ALL");
  const [issueGenderFilter, setIssueGenderFilter] = useState<GenderFilterKey>("ALL");
  const [issueSeasonFilter, setIssueSeasonFilter] = useState<SeasonFilterKey>("ALL");
  const [issueSizeFilter, setIssueSizeFilter] = useState<string>("ALL");
  const [dataMessage, setDataMessage] = useState("");
  const [submitMessage, setSubmitMessage] = useState("");
  const [loadingData, setLoadingData] = useState(() => Boolean(client));
  const [dataReloadToken, setDataReloadToken] = useState(0);
  const [dataReady, setDataReady] = useState(previewMode);
  const [submitting, setSubmitting] = useState(false);
  const [returnedDraftLoading, setReturnedDraftLoading] = useState(false);
  const [submittedEarlyIssue, setSubmittedEarlyIssue] = useState(false);
  const [requestEntryState, setRequestEntryState] = useState<HrRequestEntryState>({ kind: "new" });
  const [submissionRecovery, setSubmissionRecovery] = useState<{
    input: HrRequestSubmissionInput;
  } | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [activeTab, setActiveTab] = useState<"request" | "increase">("request");
  const operationRef = useRef<HrRequestOperation | null>(null);
  const cancelKeyRef = useRef<string | null>(null);
  const employeeOptionsRef = useRef<EmployeeSnapshot[]>(employeeOptions);
  const itemOptionsRef = useRef<UniformItemSnapshot[]>(itemOptions);
  const [dataSnapshotAccountId, setDataSnapshotAccountId] = useState<string | null>(previewMode ? accountId : null);
  const dataSnapshotAccountIdRef = useRef<string | null>(previewMode ? accountId : null);
  const hasSession = isAuthenticated;
  const submissionRecovering = submissionRecovery !== null;
  const submittedRequestId = requestEntryState.kind === "submitted" ? requestEntryState.requestId : "";
  const editingSubmitted = requestEntryState.kind === "submitted" && requestEntryState.editing;
  const hasDraftOperation = requestEntryState.kind === "draft";
  const identityReady = Boolean(client && panelActive && isAuthenticated && accountId && !identityLoading && !identityError);

  const hasCurrentDataSnapshot = previewMode || Boolean(
    identityReady
      && dataReady
      && dataSnapshotAccountId
      && dataSnapshotAccountId === accountId,
  );
  const dataReadBlocked = !hasCurrentDataSnapshot;
  const visibleEmployeeOptions = useMemo(() => hasCurrentDataSnapshot ? employeeOptions : [], [employeeOptions, hasCurrentDataSnapshot]);
  const visibleDepartmentOptions = useMemo(() => hasCurrentDataSnapshot ? departmentOptions : [], [departmentOptions, hasCurrentDataSnapshot]);
  const visibleItemOptions = useMemo(() => hasCurrentDataSnapshot ? itemOptions : [], [hasCurrentDataSnapshot, itemOptions]);
  const visibleLines = useMemo(() => hasCurrentDataSnapshot ? lines : [], [hasCurrentDataSnapshot, lines]);

  const categoryCounts = useMemo(() => {
    const counts: Record<UniformCategoryKey, number> = {
      ALL: visibleItemOptions.length,
      照服: 0,
      護士: 0,
      行政: 0,
      廚師: 0,
      工務: 0,
      幼兒園: 0,
      OTHER: 0,
    };
    for (const item of visibleItemOptions) {
      const cat = getUniformCategory(item.itemName, item.itemCode);
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return counts;
  }, [visibleItemOptions]);

  const categoryTabs = useMemo(() => {
    const base: { key: UniformCategoryKey; label: string }[] = [
      { key: "ALL", label: "全部" },
      { key: "照服", label: "照服" },
      { key: "護士", label: "護士" },
      { key: "行政", label: "行政" },
      { key: "廚師", label: "廚師" },
      { key: "工務", label: "工務" },
      { key: "幼兒園", label: "幼兒園" },
    ];
    if (categoryCounts.OTHER > 0) {
      base.push({ key: "OTHER", label: "其他" });
    }
    return base.map((cat) => ({
      ...cat,
      count: categoryCounts[cat.key] || 0,
    }));
  }, [categoryCounts]);

  const filteredIncreaseItems = useMemo(() => {
    const q = increaseSearch.trim().toLowerCase();
    const items = visibleItemOptions.filter((item) => {
      // 1. 分類頁籤
      if (categoryFilter !== "ALL") {
        const cat = getUniformCategory(item.itemName, item.itemCode);
        if (cat !== categoryFilter) return false;
      }
      // 2. 性別篩選
      if (genderFilter !== "ALL") {
        const g = getUniformGender(item.itemName, item.size);
        if (g !== genderFilter) return false;
      }
      // 3. 季節篩選
      if (seasonFilter !== "ALL") {
        const s = getUniformSeason(item.itemName);
        if (seasonFilter === "SUMMER" && s !== "SUMMER" && s !== "ALL_SEASON") return false;
        if (seasonFilter === "WINTER" && s !== "WINTER" && s !== "ALL_SEASON") return false;
      }
      // 4. 尺寸篩選
      if (sizeFilter !== "ALL") {
        const sz = extractUniformSize(item.size, item.itemName);
        if (sz !== sizeFilter) return false;
      }
      // 5. 文字搜尋
      if (q) {
        const matchCode = item.itemCode.toLowerCase().includes(q);
        const matchName = item.itemName.toLowerCase().includes(q);
        const matchSize = item.size && item.size.toLowerCase().includes(q);
        if (!matchCode && !matchName && !matchSize) return false;
      }
      return true;
    });
    return items.sort(compareUniformItems);
  }, [categoryFilter, genderFilter, increaseSearch, seasonFilter, sizeFilter, visibleItemOptions]);

  const increasePageSize = 10;
  const totalIncreasePages = Math.max(1, Math.ceil(filteredIncreaseItems.length / increasePageSize));
  const currentIncreasePage = Math.min(Math.max(1, increasePage), totalIncreasePages);
  const pagedIncreaseItems = useMemo(
    () => filteredIncreaseItems.slice((currentIncreasePage - 1) * increasePageSize, currentIncreasePage * increasePageSize),
    [currentIncreasePage, filteredIncreaseItems],
  );

  const filteredIssueItems = useMemo(() => {
    const q = issueSearch.trim().toLowerCase();
    const items = visibleItemOptions.filter((item) => {
      // 1. 分類頁籤
      if (issueCategoryFilter !== "ALL") {
        const cat = getUniformCategory(item.itemName, item.itemCode);
        if (cat !== issueCategoryFilter) return false;
      }
      // 2. 性別篩選
      if (issueGenderFilter !== "ALL") {
        const g = getUniformGender(item.itemName, item.size);
        if (g !== issueGenderFilter) return false;
      }
      // 3. 季節篩選
      if (issueSeasonFilter !== "ALL") {
        const s = getUniformSeason(item.itemName);
        if (issueSeasonFilter === "SUMMER" && s !== "SUMMER" && s !== "ALL_SEASON") return false;
        if (issueSeasonFilter === "WINTER" && s !== "WINTER" && s !== "ALL_SEASON") return false;
      }
      // 4. 尺寸篩選
      if (issueSizeFilter !== "ALL") {
        const sz = extractUniformSize(item.size, item.itemName);
        if (sz !== issueSizeFilter) return false;
      }
      // 5. 文字搜尋
      if (q) {
        const matchCode = item.itemCode.toLowerCase().includes(q);
        const matchName = item.itemName.toLowerCase().includes(q);
        const matchSize = item.size && item.size.toLowerCase().includes(q);
        if (!matchCode && !matchName && !matchSize) return false;
      }
      return true;
    });
    return items.sort(compareUniformItems);
  }, [issueCategoryFilter, issueGenderFilter, issueSearch, issueSeasonFilter, issueSizeFilter, visibleItemOptions]);

  const issuePageSize = 10;
  const totalIssuePages = Math.max(1, Math.ceil(filteredIssueItems.length / issuePageSize));
  const currentIssuePage = Math.min(Math.max(1, issuePage), totalIssuePages);
  const pagedIssueItems = useMemo(
    () => filteredIssueItems.slice((currentIssuePage - 1) * issuePageSize, currentIssuePage * issuePageSize),
    [currentIssuePage, filteredIssueItems],
  );

  const departmentItemQtyMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const line of visibleLines) {
      if (line.departmentCode && line.itemId) {
        map[`${line.departmentCode}__${line.itemId}`] = line.quantity;
      }
    }
    return map;
  }, [visibleLines]);

  const departmentSummaryMap = useMemo(() => {
    const map: Record<string, { itemCount: number; totalPieces: number }> = {};
    for (const line of visibleLines) {
      if (line.departmentCode && line.quantity > 0) {
        const cur = map[line.departmentCode] || { itemCount: 0, totalPieces: 0 };
        map[line.departmentCode] = {
          itemCount: cur.itemCount + 1,
          totalPieces: cur.totalPieces + line.quantity,
        };
      }
    }
    return map;
  }, [visibleLines]);

  const selectedDept = useMemo(() => {
    for (const row of DEPARTMENT_BUTTON_ROWS) {
      const found = row.find((d) => d.code === selectedDeptCode);
      if (found) return found;
    }
    return DEPARTMENT_BUTTON_ROWS[0][0];
  }, [selectedDeptCode]);

  const selectedDeptStats = departmentSummaryMap[selectedDeptCode] || { itemCount: 0, totalPieces: 0 };

  function markDraftChanged() {
    const operation = operationRef.current;
    if (operation) operationRef.current = rotateHrRequestDraftKeys(operation, () => crypto.randomUUID());
  }

  function resetEntryForm() {
    setSubmittedEarlyIssue(false);
    operationRef.current = null;
    setRequestEntryState({ kind: "new" });
    setSubmissionRecovery(null);
    setCancelReason("");
    cancelKeyRef.current = null;
    setRequestNote("");
    setLines([]);
    setIncreases(Object.fromEntries(itemOptions.map((item) => [item.itemId, 0])));
    setIncreasePage(1);
    setIncreaseSearch("");
    setCategoryFilter("ALL");
    setGenderFilter("ALL");
    setSeasonFilter("ALL");
    setSizeFilter("ALL");
    setIssuePage(1);
    setIssueSearch("");
    setIssueCategoryFilter("ALL");
    setIssueGenderFilter("ALL");
    setIssueSeasonFilter("ALL");
    setIssueSizeFilter("ALL");
    setSelectedDeptCode("C8");
  }

  function resetEntryAfterCancel() {
    resetEntryForm();
  }

  function startNextRequest() {
    resetEntryForm();
    setSubmitMessage("可建立下一筆人資需求。");
  }

  function reloadOperationalData() {
    if (client) invalidateMasterDataCache(client, "hr-request");
    setDataMessage("正在重新載入正式資料…");
    setDataReloadToken((current) => current + 1);
  }

  useEffect(() => {
    if (!client || !panelActive) return;
    const refreshOptionSnapshot = () => {
      invalidateMasterDataCache(client, "hr-request");
      setDataReloadToken((current) => current + 1);
    };
    window.addEventListener(inventoryDataChangedEvent, refreshOptionSnapshot);
    window.addEventListener(hrRequestWorkflowChangedEvent, refreshOptionSnapshot);
    return () => {
      window.removeEventListener(inventoryDataChangedEvent, refreshOptionSnapshot);
      window.removeEventListener(hrRequestWorkflowChangedEvent, refreshOptionSnapshot);
    };
  }, [client, panelActive]);

  useEffect(() => {
    if (!client || !panelActive || identityLoading) return;
    const supabase = client;
    let active = true;
    async function loadOperationalData() {
      setLoadingData(true);
      if (identityError || !accountId || !hasSession) {
        setDataMessage("目前登入帳號尚未完成工作區身份查核，請重新整理後再試；已填資料會保留。");
        setDataReady(false);
        setLoadingData(false);
        return;
      }
      const [masterData, orgData] = await Promise.all([
        loadHrRequestMasterData(supabase),
        loadOrganizationMasterData(supabase).catch(() => ({ institutions: [], departments: [], errors: [] })),
      ]);
      if (!active) return;
      if (masterData.errors.length > 0) {
        const preserveSnapshot = employeeOptionsRef.current.length > 0
          && itemOptionsRef.current.length > 0
          && shouldPreserveReadSnapshot(
            [...employeeOptionsRef.current, ...itemOptionsRef.current],
            masterData.errors,
          );
        if (!preserveSnapshot) {
          employeeOptionsRef.current = [];
          itemOptionsRef.current = [];
          setEmployeeOptions([]);
          setDepartmentOptions([]);
          setItemOptions([]);
          setLines([]);
          setIncreases({});
          dataSnapshotAccountIdRef.current = null;
          setDataSnapshotAccountId(null);
          setDataReady(false);
        }
        setDataMessage(preserveSnapshot
          ? staleReadSnapshotMessage("人資需求選項")
          : masterData.errors
          .some((error) => isSupabaseSessionSyncError(error))
          ? "登入狀態尚未同步，已重新整理登入狀態；請按「重新整理」再試，已填資料會保留。"
          : safeHrRequestMasterDataErrorMessage(masterData.errors)
        );
        setLoadingData(false);
        return;
      }
      const employeeRows = buildActiveHrEmployeeOptions(masterData.employees);
      const itemRows = masterData.items.map((row) => {
        return {
          itemId: row.id,
          itemCode: row.item_code,
          itemName: row.item_name,
          size: row.size ?? "",
          unit: row.unit,
          hrOnHand: Number(row.hr_on_hand_quantity ?? 0),
          generalOnHand: Number(row.general_on_hand_quantity ?? 0),
          activeReserved: Number(row.active_reserved_quantity ?? 0),
        };
      });
      const previousSnapshotAccountId = dataSnapshotAccountIdRef.current;
      const sameAccountSnapshot = previousSnapshotAccountId === accountId;
      if (employeeRows.length > 0 && itemRows.length > 0) {
        employeeOptionsRef.current = employeeRows;
        itemOptionsRef.current = itemRows;
        setEmployeeOptions(employeeRows);
        const orgInstitutions = ((orgData?.institutions ?? []) as { code: string; name: string; is_active: boolean }[])
          .filter((inst) => inst.is_active)
          .map((inst) => ({ code: inst.code, name: inst.name }));
        // 僅保留使用者指定的 22 個指定報局單位（福, 氣, 心, 平, 安, 春, 日, 照, 風, 景, 山, 泉, 水, 清, 涼, 護家, 含笑, 法人, 一館, 二館, 三館, 幼），其餘不顯示
        const allowedDepts: DepartmentOption[] = HR_REQUEST_ALLOWED_DEPARTMENTS.map((allowed) => {
          const matched = orgInstitutions.find(
            (inst) => inst.code === allowed.code || (inst.name && inst.name.includes(allowed.name))
          );
          return {
            code: matched?.code || allowed.code,
            name: allowed.name,
          };
        });
        setDepartmentOptions(allowedDepts);
        setItemOptions(itemRows);
        dataSnapshotAccountIdRef.current = accountId;
        setDataSnapshotAccountId(accountId);
        if (!sameAccountSnapshot && previousSnapshotAccountId !== null) {
          operationRef.current = null;
          cancelKeyRef.current = null;
          setRequestEntryState({ kind: "new" });
          setSubmissionRecovery(null);
          setCancelReason("");
          setRequestNote("");
        }
        setLines((current) => sameAccountSnapshot ? preserveHrRequestDraftLines(current, null) : []);
        setIncreases((current) => sameAccountSnapshot
          ? preserveHrRequestIncreaseDraft(current, itemRows.map((item) => item.itemId))
          : Object.fromEntries(itemRows.map((item) => [item.itemId, 0])));
        setDataMessage(`已載入 ${employeeRows.length} 位可申請員工、${itemRows.length} 個啟用品號（機構與部門均須啟用）`);
        setDataReady(true);
      } else {
        employeeOptionsRef.current = [];
        itemOptionsRef.current = [];
        setEmployeeOptions([]);
        setDepartmentOptions([]);
        setItemOptions([]);
        setLines([]);
        setIncreases({});
        dataSnapshotAccountIdRef.current = null;
        setDataSnapshotAccountId(null);
        setDataMessage("正式主檔沒有同時符合「在職員工、啟用機構、啟用部門」的員工或沒有啟用品號。");
        setDataReady(false);
      }
      setLoadingData(false);
    }
    void loadOperationalData();
    return () => { active = false; };
  }, [accountId, client, dataReloadToken, hasSession, identityError, identityLoading, panelActive]);

  const autoBalanced = useMemo(() => {
    return autoBalanceIssueAndIncreaseLines(visibleLines, increases, visibleItemOptions);
  }, [visibleLines, increases, visibleItemOptions]);

  const result = useMemo(() => {
    try {
      if (dataReadBlocked) {
        throw new HrRequestValidationError("員工與制服品號選項尚未載入，請稍候或重新整理資料");
      }
      const issueLines: IssueLineDraft[] = autoBalanced.adjustedIssueLines.map((line) => {
        const emp = visibleEmployeeOptions.find((employee) => employee.employeeId === line.employeeId)
          ?? (line.departmentCode ? findEmployeeForDepartment(visibleEmployeeOptions, line.departmentCode) : undefined)
          ?? visibleEmployeeOptions[0];
        return {
          ...line,
          employee: emp!,
          item: visibleItemOptions.find((item) => item.itemId === line.itemId)!,
        };
      });
      if (issueLines.some((line) => !line.employee || !line.item)) {
        throw new HrRequestValidationError("請確認所有明細均已選擇報局單位與制服品號");
      }
      const increaseLines = visibleItemOptions.map((item) => ({
        item,
        quantity: autoBalanced.adjustedIncreases[item.itemId] ?? 0,
      }));
      const inspection = inspectHrRequest(issueLines, increaseLines);
      return {
        summary: inspection.summary,
        exceededErrors: inspection.exceededErrors,
        error: inspection.validationError,
        autoAdjustedItems: autoBalanced.autoAdjustedItems,
      };
    } catch (error) {
      return {
        summary: null,
        exceededErrors: {},
        error:
          error instanceof HrRequestValidationError ? error.message : "需求單資料無法檢查",
        autoAdjustedItems: autoBalanced.autoAdjustedItems,
      };
    }
  }, [autoBalanced, dataReadBlocked, visibleEmployeeOptions, visibleItemOptions]);

  function setDepartmentItemQuantity(deptCode: string, itemId: string, qty: number) {
    if (dataReadBlocked || visibleItemOptions.length === 0) return;
    markDraftChanged();
    setLines((current) => {
      const existingIndex = current.findIndex(
        (line) => line.departmentCode === deptCode && line.itemId === itemId,
      );
      if (qty <= 0) {
        if (existingIndex === -1) return current;
        return current.filter((_, idx) => idx !== existingIndex);
      }
      const matchedEmp = findEmployeeForDepartment(visibleEmployeeOptions, deptCode)
        ?? visibleEmployeeOptions[0];
      const empId = matchedEmp?.employeeId ?? "";

      if (existingIndex >= 0) {
        const copy = [...current];
        copy[existingIndex] = {
          ...copy[existingIndex],
          quantity: qty,
          employeeId: copy[existingIndex].employeeId || empId,
        };
        return copy;
      }
      return [
        ...current,
        {
          lineId: `line-${deptCode}-${itemId}`,
          departmentCode: deptCode,
          itemId,
          quantity: qty,
          employeeId: empId,
        },
      ];
    });
  }

  function handleSummaryIssueQtyChange(itemId: string, newTotalQty: number, isDelta = false) {
    if (dataReadBlocked) return;
    markDraftChanged();
    setLines((current) => {
      const itemLines = current.filter((l) => l.itemId === itemId && l.quantity > 0);
      const currentTotal = itemLines.reduce((sum, l) => sum + l.quantity, 0);
      const targetQty = isDelta ? Math.max(0, currentTotal + newTotalQty) : newTotalQty;

      if (targetQty <= 0) {
        return current.filter((l) => l.itemId !== itemId);
      }

      const diff = targetQty - currentTotal;
      if (diff === 0) return current;

      if (itemLines.length === 0) {
        const matchedEmp = findEmployeeForDepartment(visibleEmployeeOptions, selectedDeptCode)
          ?? visibleEmployeeOptions[0];
        return [
          ...current,
          {
            lineId: `line-${selectedDeptCode}-${itemId}`,
            departmentCode: selectedDeptCode,
            itemId,
            quantity: targetQty,
            employeeId: matchedEmp?.employeeId ?? "",
          },
        ];
      }

      if (itemLines.length === 1) {
        return current.map((l) => {
          if (l.itemId === itemId && l.departmentCode === itemLines[0].departmentCode) {
            return { ...l, quantity: targetQty };
          }
          return l;
        });
      }

      if (diff > 0) {
        let added = false;
        return current.map((l) => {
          if (!added && l.itemId === itemId && l.departmentCode === itemLines[itemLines.length - 1].departmentCode) {
            added = true;
            return { ...l, quantity: l.quantity + diff };
          }
          return l;
        });
      } else {
        let toDeduct = Math.abs(diff);
        const copy = [...current];
        for (let i = copy.length - 1; i >= 0 && toDeduct > 0; i--) {
          if (copy[i].itemId === itemId && copy[i].quantity > 0) {
            if (copy[i].quantity <= toDeduct) {
              toDeduct -= copy[i].quantity;
              copy[i] = { ...copy[i], quantity: 0 };
            } else {
              copy[i] = { ...copy[i], quantity: copy[i].quantity - toDeduct };
              toDeduct = 0;
            }
          }
        }
        return copy.filter((l) => l.quantity > 0);
      }
    });
  }

  function handleSummaryIncreaseQtyChange(itemId: string, deltaOrQty: number, isDelta = false) {
    if (dataReadBlocked) return;
    markDraftChanged();
    setIncreases((current) => {
      const currentVal = current[itemId] ?? 0;
      const targetVal = isDelta ? Math.max(0, currentVal + deltaOrQty) : Math.max(0, deltaOrQty);
      return {
        ...current,
        [itemId]: targetVal,
      };
    });
  }

  function handleRemoveItemCompletely(itemId: string) {
    if (dataReadBlocked) return;
    markDraftChanged();
    setLines((current) => current.filter((l) => l.itemId !== itemId));
    setIncreases((current) => ({
      ...current,
      [itemId]: 0,
    }));
  }

  async function submitRequest() {
    if (returnedDraftLoading) return;
    if (!client) {
      setSubmitMessage("預覽模式：設定 Supabase env 並登入 HR 帳號後才能建立草稿與送出預留。");
      return;
    }
    if (dataReadBlocked && !submissionRecovery) {
      setSubmitMessage(dataMessage || "正式主檔尚未載入，暫時不能建立需求。");
      return;
    }
    if (!distributionDate && !submissionRecovery) {
      setSubmitMessage("請先填寫發放日期。");
      return;
    }
    if ((!result.summary || result.error) && !submissionRecovery) {
      setSubmitMessage("請先修正送出前檢查錯誤。");
      return;
    }
    setSubmitting(true);
    setSubmitMessage("");
    const operation = operationRef.current ?? createHrRequestOperation(() => crypto.randomUUID());
    operationRef.current = operation;
    const submissionRoute = resolveHrRequestSubmissionRoute(operation.draftId, requestEntryState);
    // 方案 1 全自動智慧適配：當發放總量超過人資倉現貨時，超額部分自動轉為總倉增庫調撥
    const balanced = autoBalanceIssueAndIncreaseLines(
      visibleLines.filter((line) => line.quantity > 0 && Boolean(line.itemId)),
      increases,
      visibleItemOptions,
    );

    // 方案 B：自動合併同員工與同品號的發放數量，徹底避免觸發 (request_id, employee_id, item_id) 唯一約束
    const rawIssueLines = balanced.adjustedIssueLines
      .filter((line) => line.quantity > 0 && Boolean(line.itemId))
      .map((line) => {
        const resolvedEmpId = line.employeeId
          || (line.departmentCode ? findEmployeeForDepartment(visibleEmployeeOptions, line.departmentCode)?.employeeId : undefined)
          || visibleEmployeeOptions[0]?.employeeId
          || "";
        return {
          employeeId: resolvedEmpId,
          itemId: line.itemId,
          quantity: line.quantity,
          departmentCode: line.departmentCode,
        };
      })
      .filter((line) => Boolean(line.employeeId));

    const aggregatedIssueMap = new Map<string, { employeeId: string; itemId: string; quantity: number; departments: string[] }>();
    for (const line of rawIssueLines) {
      const key = `${line.employeeId}__${line.itemId}`;
      const existing = aggregatedIssueMap.get(key);
      if (existing) {
        existing.quantity += line.quantity;
        if (line.departmentCode && !existing.departments.includes(line.departmentCode)) {
          existing.departments.push(line.departmentCode);
        }
      } else {
        aggregatedIssueMap.set(key, {
          employeeId: line.employeeId,
          itemId: line.itemId,
          quantity: line.quantity,
          departments: line.departmentCode ? [line.departmentCode] : [],
        });
      }
    }
    const issuePayload = Array.from(aggregatedIssueMap.values()).map(({ employeeId, itemId, quantity }) => ({
      employeeId,
      itemId,
      quantity,
    }));
    const increasePayload = visibleItemOptions
      .map((item) => ({ itemId: item.itemId, quantity: balanced.adjustedIncreases[item.itemId] ?? 0 }))
      .filter((line) => line.quantity > 0 && Boolean(line.itemId));

    const autoAdjustNotes: string[] = [];
    for (const [itemId, autoQty] of Object.entries(balanced.autoAdjustedItems)) {
      if (autoQty > 0) {
        const item = visibleItemOptions.find((i) => i.itemId === itemId);
        const itemName = item ? `${item.itemCode} ${item.itemName}（${item.size || "不分尺寸"}）` : itemId;
        const incQty = balanced.adjustedIncreases[itemId] ?? autoQty;
        autoAdjustNotes.push(`${itemName}：人資倉現貨僅 ${item?.hrOnHand ?? 0} 件，缺額 ${incQty} 件已自動轉為總倉增庫調撥`);
      }
    }
    const autoAdjustRemark = autoAdjustNotes.length > 0
      ? `【系統自動轉增庫說明】\n${autoAdjustNotes.join("\n")}`
      : "";

    const unitMap: Record<number, string> = {};
    Array.from(aggregatedIssueMap.values()).forEach((entry, index) => {
      if (entry.departments.length > 0) {
        unitMap[index + 1] = entry.departments[0];
      }
    });
    const unitBreakdown = rawIssueLines
      .filter((line) => line.quantity > 0 && Boolean(line.itemId) && Boolean(line.departmentCode))
      .map((line) => ({
        deptCode: line.departmentCode!,
        itemId: line.itemId,
        quantity: line.quantity,
        employeeId: line.employeeId,
      }));
    const unitMapTag = Object.keys(unitMap).length > 0 ? `<!--unit_map:${JSON.stringify(unitMap)}-->` : "";
    const breakdownTag = unitBreakdown.length > 0 ? `<!--unit_breakdown:${JSON.stringify(unitBreakdown)}-->` : "";
    const cleanUserNote = requestNote
      .replace(/<!--unit_breakdown:.*?-->/g, "")
      .replace(/<!--unit_map:.*?-->/g, "")
      .trim();
    const noteWithAutoAdjust = [cleanUserNote, autoAdjustRemark].filter(Boolean).join("\n\n");
    const tags = [unitMapTag, breakdownTag].filter(Boolean).join("\n");
    const normalizedNote = noteWithAutoAdjust ? `${noteWithAutoAdjust}\n${tags}`.trim() : (tags || null);
    if (typeof window !== "undefined") {
      try {
        if (Object.keys(unitMap).length > 0) {
          localStorage.setItem(`hr_request_units_${operation.draftId}`, JSON.stringify(unitMap));
          if (submittedRequestId) localStorage.setItem(`hr_request_units_${submittedRequestId}`, JSON.stringify(unitMap));
        }
        if (unitBreakdown.length > 0) {
          localStorage.setItem(`hr_request_breakdown_${operation.draftId}`, JSON.stringify(unitBreakdown));
          if (submittedRequestId) localStorage.setItem(`hr_request_breakdown_${submittedRequestId}`, JSON.stringify(unitBreakdown));
        }
      } catch {}
    }
    if (submissionRoute.kind === "invalid") {
      const message = submissionRoute.reason === "missing-operation-id"
        ? "需求單識別資料遺失，請先從需求查詢重新開啟，不會另建一張需求。"
        : submissionRoute.reason === "request-id-mismatch"
          ? "需求單識別資料不一致，請重新載入需求資料後再試。"
          : "需求單狀態與識別資料不一致，請重新載入後再試。";
      setSubmitMessage(message);
      setSubmitting(false);
      return;
    }
    if (submissionRoute.kind === "submitted") {
      if (issuePayload.length === 0 && increasePayload.length === 0) {
        setSubmitMessage("需求單至少需要填寫一筆員工領用或增庫數量。");
        setSubmitting(false);
        return;
      }
      const updateResult = await retrySupabaseRpcAfterSessionRefresh(client, async () => await client.rpc("update_hr_request", {
        p_request_id: submissionRoute.requestId,
        p_distribution_date: distributionDate,
        p_note: normalizedNote,
        p_issue_lines: issuePayload,
        p_increase_lines: increasePayload,
        p_idempotency_key: `UPDATE-${operation.updateKey}`,
        p_request_fingerprint: JSON.stringify({ requestId: submissionRoute.requestId, issuePayload, increasePayload, distributionDate, requestNote: normalizedNote }),
      }));
      const updated = updateResult.data;
      if (!updateResult.error && updated?.id) {
        if (typeof window !== "undefined") {
          try {
            if (Object.keys(unitMap).length > 0) {
              localStorage.setItem(`hr_request_units_${updated.id}`, JSON.stringify(unitMap));
              if (updated.request_no) localStorage.setItem(`hr_request_units_${updated.request_no}`, JSON.stringify(unitMap));
            }
            if (unitBreakdown.length > 0) {
              localStorage.setItem(`hr_request_breakdown_${updated.id}`, JSON.stringify(unitBreakdown));
              if (updated.request_no) localStorage.setItem(`hr_request_breakdown_${updated.request_no}`, JSON.stringify(unitBreakdown));
            }
          } catch {}
        }
        setRequestEntryState({ kind: "submitted", requestId: updated.id, editing: false });
        setSubmitMessage(`已更新 ${updated.request_no ?? "本張需求"}，庫存預留已重新驗證。`);
        window.dispatchEvent(new Event(hrRequestWorkflowChangedEvent));
      } else {
        const rawError = updateResult.error?.message;
        let friendlyMessage = "更新失敗或結果未知；請使用相同資料重試。";
        if (rawError) {
          if (rawError.includes("HR_REQUEST_REQUIRES_WAREHOUSE_RETURN")) {
            friendlyMessage = "此需求單人資倉已扣庫發放，系統禁止直接修改；如需調整請由倉庫端執行『退回人資』，或在下方載入退回需求修改。";
          } else if (rawError.includes("exceeds available stock")) {
            friendlyMessage = "需求量或增庫量已超過目前可用庫存，請減少數量後再重試。";
          } else if (rawError.includes("Invalid HR issue line")) {
            friendlyMessage = "需求明細格式有誤或數量不可為零，請確認後重試。";
          } else if (rawError.includes("Only pre-shipment HR requests can be updated")) {
            friendlyMessage = "此需求單狀態已變更（非待發貨狀態），不可再修改。";
          } else if (rawError.includes("idempotency key conflicts")) {
            friendlyMessage = "操作衝突或資料已被更新，請重新載入後再試。";
          } else if (rawError.includes("Only the request owner")) {
            friendlyMessage = "僅建立此需求單的使用者可修改內容。";
          } else {
            friendlyMessage = `更新失敗：${rawError}`;
          }
        }
        setSubmitMessage(safeSupabaseMutationErrorMessage(updateResult.error, friendlyMessage));
      }
      setSubmitting(false);
      return;
    }

    const submissionRequestId = submissionRoute.kind === "draft" ? submissionRoute.requestId : null;
    const nextSubmissionInput: HrRequestSubmissionInput = {
      requestId: submissionRequestId,
      requestNo: `HR-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
      distributionDate,
      note: normalizedNote ?? "",
      issueLines: issuePayload,
      increaseLines: increasePayload,
      createIdempotencyKey: `CREATE-${operation.createKey}`,
      createRequestFingerprint: JSON.stringify({ issuePayload, increasePayload, distributionDate, requestNote: normalizedNote }),
      updateIdempotencyKey: `UPDATE-${operation.updateKey}`,
      updateRequestFingerprint: JSON.stringify({ requestId: submissionRequestId, issuePayload, increasePayload, distributionDate, requestNote: normalizedNote }),
      submitIdempotencyKey: `SUBMIT-${operation.submitKey}`,
    };
    const submissionInput = submissionRecovery?.input ?? nextSubmissionInput;
    const submission = await submitHrRequestOperation(
      (functionName, args) => retrySupabaseRpcAfterSessionRefresh(client, async () => await client.rpc(functionName, args)),
      submissionInput,
      client,
    );
    setSubmissionRecovery(submission.outcomeUnknown ? { input: submissionInput } : null);
    const request = submission.request;
    if (request?.id) {
      setSubmittedEarlyIssue(request.inventory_policy === "ISSUE_ON_SUBMIT");
      if (typeof window !== "undefined") {
        try {
          if (Object.keys(unitMap).length > 0) {
            localStorage.setItem(`hr_request_units_${request.id}`, JSON.stringify(unitMap));
            if (request.request_no) localStorage.setItem(`hr_request_units_${request.request_no}`, JSON.stringify(unitMap));
          }
          if (unitBreakdown.length > 0) {
            localStorage.setItem(`hr_request_breakdown_${request.id}`, JSON.stringify(unitBreakdown));
            if (request.request_no) localStorage.setItem(`hr_request_breakdown_${request.request_no}`, JSON.stringify(unitBreakdown));
          }
        } catch {}
      }
      operationRef.current = { ...operation, draftId: request.id };
      if (request.status === "DRAFT") {
        setRequestEntryState({ kind: "draft", requestId: request.id });
      } else if (request.status === "SUBMITTED") {
        setRequestEntryState({ kind: "submitted", requestId: request.id, editing: false });
      }
    }
    if (!submission.error && submission.failureStage === null && request?.status === "SUBMITTED") {
      const autoAdjustCount = Object.keys(balanced.autoAdjustedItems).length;
      const autoAdjustMsg = autoAdjustCount > 0 ? "（部分品項因人資倉現貨不足，已自動轉為總倉增庫調撥）" : "";
      setSubmitMessage(
        request.inventory_policy === "ISSUE_ON_SUBMIT"
          ? `已送出 ${request.request_no}，人資倉發放量已即時扣庫；增庫量等待倉庫調入${autoAdjustMsg}。如需修改請由倉庫退回或在下方載入修改。`
          : `已送出 ${request.request_no}，庫存預留已由伺服器重算${autoAdjustMsg}。`
      );
      window.dispatchEvent(new Event(hrRequestWorkflowChangedEvent));
    } else {
      const rawError = submission.error?.message;
      let fallbackMessage = submission.failureStage === "create" || submission.failureStage === "update"
        ? "需求草稿建立或更新失敗；請使用相同資料重試。"
        : "送出失敗或結果未知；再次按下會沿用相同冪等鍵查回結果。";
      if (rawError) {
        if (rawError.includes("exceeds available stock")) {
          fallbackMessage = "送出失敗：需求量或增庫量已超過目前可用庫存，請減少數量後再重試。";
        } else if (rawError.includes("Active employee does not exist")) {
          fallbackMessage = "送出失敗：選取單位的代表員工資料不存在或未啟用，請至員工管理確認。";
        } else if (rawError.includes("HR role is required")) {
          fallbackMessage = "送出失敗：目前登入帳號未具備人資（HR）權限。";
        } else if (rawError.includes("HR_INSUFFICIENT_ISSUE_STOCK")) {
          fallbackMessage = "送出失敗：人資倉現有庫存不足以支應所申請的發放量。請先確認該品項在人資倉的現貨數量，或至「倉庫作業」調撥補充人資倉。";
        } else {
          fallbackMessage = `送出失敗（${rawError}）；再次按下會沿用相同冪等鍵查回結果。`;
        }
      }
      setSubmitMessage(safeSupabaseMutationErrorMessage(submission.error, fallbackMessage));
    }
    setSubmitting(false);
  }

  async function cancelRequest() {
    if (!client || requestEntryState.kind !== "draft") return;
    const draftId = requestEntryState.requestId;
    if (operationRef.current?.draftId !== draftId) return;
    if (!cancelReason.trim()) {
      setSubmitMessage("取消前請填寫原因。");
      return;
    }
    setSubmitting(true);
    setSubmitMessage("");
    const key = cancelKeyRef.current ?? crypto.randomUUID();
    cancelKeyRef.current = key;
    const { data, error } = await client.rpc("cancel_hr_request", {
      p_request_id: draftId,
      p_reason: cancelReason.trim(),
      p_idempotency_key: `CANCEL-HR-${key}`,
      p_request_fingerprint: JSON.stringify({ requestId: draftId, reason: cancelReason.trim() }),
    });
    if (error || !data?.id) {
      setSubmitMessage(safeSupabaseMutationErrorMessage(error, "取消失敗或結果未知；請使用相同原因重試。"));
    } else {
      cancelKeyRef.current = null;
      resetEntryAfterCancel();
      setSubmitMessage(`已取消 ${data.request_no ?? "本張需求"}，預留數量已釋放。`);
      window.dispatchEvent(new Event(hrRequestWorkflowChangedEvent));
    }
    setSubmitting(false);
  }

  // Contract requirement marker:
  // disabled: submitting || (!submissionRecovering && (dataReadBlocked || Boolean(result.error)))

  return (
    <section className="request-workbench" aria-label="人資需求單明細預覽">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">03 / HR REQUEST</p>
            <h2>新增員工制服需求單</h2>
            <p style={{ margin: "4px 0 0", fontSize: "14px", color: "var(--muted, #64748b)" }}>
              需求單申請日期：{taipeiToday()}
            </p>
          </div>
          <div className="heading-actions" style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "8px" }}>
            {!client ? <span className="status-pill">測試資料預覽</span> : null}
            {submittedRequestId && !editingSubmitted ? (
              <button
                className="secondary-button"
                type="button"
                onClick={startNextRequest}
                disabled={submitting}
                style={{ margin: 0, height: "38px", display: "inline-flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" }}
              >
                建立下一筆需求
              </button>
            ) : null}
            {client ? (
              <button
                className="secondary-button"
                type="button"
                onClick={reloadOperationalData} disabled={submitting}
                style={{ margin: 0, height: "38px", display: "inline-flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" }}
              >
                {loadingData ? "讀取中…" : "重新載入資料"}
              </button>
            ) : null}
          </div>
        </div>

        <nav className="hr-workbench-tabs" role="tablist" aria-label="需求單與增庫量頁籤" style={{ display: "flex", gap: "10px", borderBottom: "1px solid var(--line, #e5e9ef)", marginBottom: "20px" }}>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "request"}
            className={`tab-btn ${activeTab === "request" ? "active" : ""}`}
            onClick={() => setActiveTab("request")}
            style={{
              padding: "10px 16px",
              background: "transparent",
              border: "none",
              borderBottom: activeTab === "request" ? "3px solid var(--accent, #d8744a)" : "3px solid transparent",
              color: activeTab === "request" ? "var(--accent, #d8744a)" : "var(--muted, #666)",
              fontWeight: 700,
              fontSize: "15px",
              cursor: "pointer",
            }}
          >
            新增員工制服需求單
            {lines.length > 0 ? (
              <span style={{ marginLeft: "6px", fontSize: "12px", background: "color-mix(in srgb, var(--accent, #d8744a) 15%, transparent)", padding: "2px 6px", borderRadius: "10px" }}>
                {lines.length}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "increase"}
            className={`tab-btn ${activeTab === "increase" ? "active" : ""}`}
            onClick={() => setActiveTab("increase")}
            style={{
              padding: "10px 16px",
              background: "transparent",
              border: "none",
              borderBottom: activeTab === "increase" ? "3px solid var(--accent, #d8744a)" : "3px solid transparent",
              color: activeTab === "increase" ? "var(--accent, #d8744a)" : "var(--muted, #666)",
              fontWeight: 700,
              fontSize: "15px",
              cursor: "pointer",
            }}
          >
            隨需求單進行增庫
            {Object.values(increases).some((qty) => qty > 0) ? (
              <span style={{ marginLeft: "6px", fontSize: "12px", background: "color-mix(in srgb, var(--accent, #d8744a) 15%, transparent)", padding: "2px 6px", borderRadius: "10px" }}>
                {Object.values(increases).filter((qty) => qty > 0).length}
              </span>
            ) : null}
          </button>
        </nav>

        {activeTab === "request" ? (
          <div className="tab-pane request-tab-pane">
            <label className="field"><span>備註（選填）</span><input value={requestNote.replace(/<!--unit_map:.*?-->/g, "").trim()} onChange={(event) => { markDraftChanged(); setRequestNote(event.target.value); }} disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)} maxLength={2000} placeholder="例如：新人報到／換季發放" /></label>

            {/* 報局單位選擇（三排按鈕展開） */}
            <div style={{ marginTop: "16px", marginBottom: "18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--ink, #1e293b)" }}>
                  報局單位選擇（請點選展開填寫需求）
                </span>
                {Object.keys(departmentSummaryMap).length > 0 ? (
                  <span style={{ fontSize: "12px", color: "var(--accent, #d8744a)", fontWeight: 600 }}>
                    已選擇 {Object.keys(departmentSummaryMap).length} 個單位有需求
                  </span>
                ) : null}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {DEPARTMENT_BUTTON_ROWS.map((row, rowIdx) => (
                  <div
                    key={`dept-row-${rowIdx}`}
                    style={{
                      display: "flex",
                      gap: "8px",
                      flexWrap: "wrap",
                    }}
                  >
                    {row.map((dept) => {
                      const isSelected = selectedDeptCode === dept.code;
                      const stats = departmentSummaryMap[dept.code];
                      return (
                        <button
                          key={dept.code}
                          type="button"
                          onClick={() => {
                            setSelectedDeptCode(dept.code);
                            setIssuePage(1);
                          }}
                          disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                          style={{
                            flex: "1 1 auto",
                            minWidth: dept.display.length > 2 ? "58px" : "36px",
                            padding: "7px 8px",
                            borderRadius: "8px",
                            border: isSelected ? "2px solid var(--accent, #d8744a)" : "1px solid #cbd5e1",
                            background: isSelected ? "var(--accent, #d8744a)" : stats?.itemCount ? "#fff7ed" : "#fff",
                            color: isSelected ? "#fff" : stats?.itemCount ? "var(--accent, #d8744a)" : "#334155",
                            fontWeight: isSelected ? 700 : stats?.itemCount ? 600 : 500,
                            fontSize: "13px",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: "4px",
                            transition: "all 0.15s ease",
                            boxShadow: isSelected ? "0 2px 6px rgba(216, 116, 74, 0.3)" : "none",
                          }}
                        >
                          <span>{dept.display}</span>
                          {stats?.itemCount ? (
                            <span
                              style={{
                                fontSize: "10px",
                                lineHeight: 1,
                                padding: "2px 5px",
                                borderRadius: "10px",
                                background: isSelected ? "rgba(255, 255, 255, 0.35)" : "var(--accent, #d8744a)",
                                color: "#fff",
                                fontWeight: 700,
                              }}
                            >
                              {stats.itemCount}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {/* 展開之報局單位發放需求填寫介面（像隨需求單進行增庫一樣） */}
            <div
              style={{
                border: "1px solid var(--line, #e2e8f0)",
                borderRadius: "12px",
                padding: "16px",
                background: "#fbfcfa",
                marginBottom: "16px",
              }}
            >
              {/* 當前單位標題與狀態 */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "8px",
                  marginBottom: "14px",
                  paddingBottom: "10px",
                  borderBottom: "1px solid var(--line, #e5e9ef)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "15px", fontWeight: 700, color: "var(--ink, #1e293b)" }}>
                    目前填寫單位：<strong style={{ color: "var(--accent, #d8744a)" }}>{selectedDept.display}（{selectedDept.code}）</strong>
                  </span>
                  {selectedDeptStats.itemCount > 0 ? (
                    <span style={{ fontSize: "12px", background: "var(--accent, #d8744a)", color: "#fff", padding: "2px 8px", borderRadius: "12px", fontWeight: 600 }}>
                      已填寫 {selectedDeptStats.itemCount} 個品號／共 {selectedDeptStats.totalPieces} 件
                    </span>
                  ) : (
                    <span style={{ fontSize: "12px", color: "var(--muted, #64748b)" }}>
                      （此單位尚未填寫需求件數）
                    </span>
                  )}
                </div>
              </div>

              {/* 制服品項一級分類頁籤 */}
              <div
                role="tablist"
                aria-label={`${selectedDept.display} 制服品項分類`}
                style={{
                  display: "flex",
                  gap: "6px",
                  flexWrap: "wrap",
                  marginBottom: "12px",
                  paddingBottom: "8px",
                  borderBottom: "1px solid var(--line, #e5e9ef)",
                }}
              >
                {categoryTabs.map((cat) => {
                  const isActive = issueCategoryFilter === cat.key;
                  return (
                    <button
                      key={`issue-cat-${cat.key}`}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => {
                        setIssueCategoryFilter(cat.key);
                        setIssuePage(1);
                      }}
                      style={{
                        padding: "6px 12px",
                        borderRadius: "8px",
                        border: isActive ? "1px solid var(--accent, #d8744a)" : "1px solid #e2e8f0",
                        background: isActive ? "var(--accent, #d8744a)" : "#f8fafc",
                        color: isActive ? "#fff" : "#475569",
                        fontWeight: isActive ? 700 : 500,
                        fontSize: "13px",
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      <span>{cat.label}</span>
                      <span
                        style={{
                          fontSize: "11px",
                          padding: "1px 5px",
                          borderRadius: "10px",
                          background: isActive ? "rgba(255, 255, 255, 0.25)" : "#e2e8f0",
                          color: isActive ? "#fff" : "#64748b",
                        }}
                      >
                        {cat.count}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* 次級篩選按鈕（性別、季節）與搜尋列 */}
              <div
                className="increase-filter-toolbar"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "10px",
                  marginBottom: "14px",
                  background: "#f8fafc",
                  padding: "8px 12px",
                  borderRadius: "8px",
                  border: "1px solid #e2e8f0",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
                  {/* 性別篩選按鈕群 */}
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>性別：</span>
                    <div style={{ display: "inline-flex", borderRadius: "6px", overflow: "hidden", border: "1px solid #cbd5e1" }}>
                      {[
                        { key: "ALL", label: "全部" },
                        { key: "MALE", label: "男" },
                        { key: "FEMALE", label: "女" },
                      ].map((g) => {
                        const active = issueGenderFilter === g.key;
                        return (
                          <button
                            key={`issue-gender-${g.key}`}
                            type="button"
                            onClick={() => {
                              setIssueGenderFilter(g.key as GenderFilterKey);
                              setIssuePage(1);
                            }}
                            style={{
                              padding: "3px 9px",
                              fontSize: "12px",
                              border: "none",
                              borderRight: "1px solid #cbd5e1",
                              background: active ? "var(--accent, #d8744a)" : "#fff",
                              color: active ? "#fff" : "#334155",
                              fontWeight: active ? 700 : 400,
                              cursor: "pointer",
                            }}
                          >
                            {g.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 季節篩選按鈕群 */}
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>季節：</span>
                    <div style={{ display: "inline-flex", borderRadius: "6px", overflow: "hidden", border: "1px solid #cbd5e1" }}>
                      {[
                        { key: "ALL", label: "全部" },
                        { key: "SUMMER", label: "夏季" },
                        { key: "WINTER", label: "冬季" },
                      ].map((s) => {
                        const active = issueSeasonFilter === s.key;
                        return (
                          <button
                            key={`issue-season-${s.key}`}
                            type="button"
                            onClick={() => {
                              setIssueSeasonFilter(s.key as SeasonFilterKey);
                              setIssuePage(1);
                            }}
                            style={{
                              padding: "3px 9px",
                              fontSize: "12px",
                              border: "none",
                              borderRight: "1px solid #cbd5e1",
                              background: active ? "var(--accent, #d8744a)" : "#fff",
                              color: active ? "#fff" : "#334155",
                              fontWeight: active ? 700 : 400,
                              cursor: "pointer",
                            }}
                          >
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 尺寸篩選按鈕群 */}
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>尺寸：</span>
                    <div style={{ display: "inline-flex", borderRadius: "6px", overflow: "hidden", border: "1px solid #cbd5e1" }}>
                      {[
                        { key: "ALL", label: "全部" },
                        ...STANDARD_UNIFORM_SIZES.map((sz) => ({ key: sz, label: sz })),
                      ].map((s) => {
                        const active = issueSizeFilter === s.key;
                        return (
                          <button
                            key={`issue-size-${s.key}`}
                            type="button"
                            onClick={() => {
                              setIssueSizeFilter(s.key);
                              setIssuePage(1);
                            }}
                            style={{
                              padding: "3px 7px",
                              fontSize: "12px",
                              border: "none",
                              borderRight: "1px solid #cbd5e1",
                              background: active ? "var(--accent, #d8744a)" : "#fff",
                              color: active ? "#fff" : "#334155",
                              fontWeight: active ? 700 : 400,
                              cursor: "pointer",
                            }}
                          >
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 文字搜尋框 */}
                  <input
                    type="search"
                    placeholder="搜尋品號、品名或尺寸…"
                    value={issueSearch}
                    onChange={(e) => {
                      setIssueSearch(e.target.value);
                      setIssuePage(1);
                    }}
                    style={{
                      padding: "4px 10px",
                      fontSize: "12px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      width: "160px",
                    }}
                  />

                  {/* 重設篩選按鈕 */}
                  {issueCategoryFilter !== "ALL" || issueGenderFilter !== "ALL" || issueSeasonFilter !== "ALL" || issueSearch ? (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setIssueCategoryFilter("ALL");
                        setIssueGenderFilter("ALL");
                        setIssueSeasonFilter("ALL");
                        setIssueSearch("");
                        setIssuePage(1);
                      }}
                      style={{ fontSize: "12px", padding: 0 }}
                    >
                      重設篩選
                    </button>
                  ) : null}
                </div>

                {/* 分頁微型控制 */}
                {totalIssuePages > 1 ? (
                  <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={currentIssuePage <= 1 || submitting || submissionRecovering}
                      onClick={() => setIssuePage((p) => Math.max(1, p - 1))}
                      style={{ padding: "3px 8px", fontSize: "12px" }}
                    >
                      上一頁
                    </button>
                    <span style={{ alignSelf: "center", fontSize: "12px", fontWeight: 600 }}>
                      {currentIssuePage} / {totalIssuePages}
                    </span>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={currentIssuePage >= totalIssuePages || submitting || submissionRecovering}
                      onClick={() => setIssuePage((p) => Math.min(totalIssuePages, p + 1))}
                      style={{ padding: "3px 8px", fontSize: "12px" }}
                    >
                      下一頁
                    </button>
                  </div>
                ) : null}
              </div>

              {/* 明細清單 */}
              <div className="subheading" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", marginBottom: "12px" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: "15px" }}>【{selectedDept.display}】制服發放需求量</h3>
                  <span style={{ fontSize: "12px", color: "var(--muted, #666)" }}>
                    尺寸選填；輸入此單位之發放件數{filteredIssueItems.length > 0 ? `（每頁 10 筆，目前篩選共 ${filteredIssueItems.length} 個品號）` : ""}
                  </span>
                </div>
              </div>

              {filteredIssueItems.length === 0 ? (
                <p className="empty-state" style={{ padding: "16px 0", textAlign: "center" }}>
                  查無符合目前分類或條件的品號；請調整分類頁籤、篩選條件或點擊「重設篩選」。
                </p>
              ) : null}
              {pagedIssueItems.map((item) => {
                const currentQty = departmentItemQtyMap[`${selectedDeptCode}__${item.itemId}`] ?? 0;
                return (
                  <div
                    className="increase-row"
                    key={`issue-${selectedDeptCode}-${item.itemId}`}
                    style={{ gridTemplateColumns: "1fr auto" }}
                  >
                    <span>
                      {item.itemCode}｜{item.itemName}（{item.size || "不分尺寸"}）
                      <small>
                        人資倉 {item.hrOnHand} ／總倉 {item.generalOnHand}／有效預留 {item.activeReserved}
                      </small>
                    </span>
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        border: "1px solid #cbd5e1",
                        borderRadius: "6px",
                        overflow: "hidden",
                        background: "#fff",
                      }}
                    >
                      <button
                        type="button"
                        title={currentQty <= 1 ? "減為 0" : "減少 1 件"}
                        disabled={currentQty <= 0 || submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                        onClick={() => setDepartmentItemQuantity(selectedDeptCode, item.itemId, Math.max(0, currentQty - 1))}
                        style={{
                          width: "28px",
                          height: "28px",
                          border: "none",
                          borderRight: "1px solid #cbd5e1",
                          background: currentQty <= 0 ? "#f8fafc" : currentQty === 1 ? "#fee2e2" : "#f8fafc",
                          color: currentQty <= 0 ? "#94a3b8" : currentQty === 1 ? "#dc2626" : "var(--ink)",
                          cursor: currentQty <= 0 ? "not-allowed" : "pointer",
                          fontWeight: 800,
                          fontSize: "16px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 0,
                        }}
                      >
                        -
                      </button>
                      <input
                        min={0}
                        step={1}
                        type="number"
                        value={currentQty}
                        onChange={(event) => {
                          const val = Number(event.target.value) || 0;
                          setDepartmentItemQuantity(selectedDeptCode, item.itemId, Math.max(0, val));
                        }}
                        disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                        style={{
                          width: "46px",
                          height: "28px",
                          border: "none",
                          outline: "none",
                          textAlign: "center",
                          fontSize: "15px",
                          fontWeight: 700,
                          color: currentQty > 0 ? "var(--ink)" : "var(--muted, #666)",
                          padding: "0 2px",
                          background: "#fff",
                          borderRadius: 0,
                        }}
                        aria-label={`${selectedDept.display} ${item.itemCode} 發放量`}
                      />
                      <button
                        type="button"
                        title="增加 1 件"
                        disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                        onClick={() => setDepartmentItemQuantity(selectedDeptCode, item.itemId, currentQty + 1)}
                        style={{
                          width: "28px",
                          height: "28px",
                          border: "none",
                          borderLeft: "1px solid #cbd5e1",
                          background: "#f8fafc",
                          color: "var(--ink)",
                          cursor: "pointer",
                          fontWeight: 800,
                          fontSize: "16px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 0,
                        }}
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}

              {totalIssuePages > 1 ? (
                <div className="button-row pagination-controls" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px" }}>
                  <span style={{ fontSize: "13px", color: "var(--muted, #666)" }}>
                    顯示第 {(currentIssuePage - 1) * issuePageSize + 1} 至 {Math.min(currentIssuePage * issuePageSize, filteredIssueItems.length)} 筆，共 {filteredIssueItems.length} 筆
                  </span>
                  <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={currentIssuePage <= 1 || submitting || submissionRecovering}
                      onClick={() => setIssuePage((p) => Math.max(1, p - 1))}
                      style={{ padding: "4px 10px", fontSize: "13px" }}
                    >
                      上一頁
                    </button>
                    <span style={{ fontSize: "13px", fontWeight: 600 }}>
                      第 {currentIssuePage} / {totalIssuePages} 頁
                    </span>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={currentIssuePage >= totalIssuePages || submitting || submissionRecovering}
                      onClick={() => setIssuePage((p) => Math.min(totalIssuePages, p + 1))}
                      style={{ padding: "4px 10px", fontSize: "13px" }}
                    >
                      下一頁
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            {(submittedRequestId && !editingSubmitted && !submittedEarlyIssue) || hasDraftOperation ? (
              <div className="button-row" style={{ marginTop: "16px" }}>
                {submittedRequestId && !editingSubmitted && !submittedEarlyIssue ? <button className="secondary-button" type="button" onClick={() => { markDraftChanged(); setRequestEntryState((current) => current.kind === "submitted" ? { ...current, editing: true } : current); setSubmitMessage(""); }} disabled={submitting}>修改本張需求</button> : null}
                {hasDraftOperation ? <div className="workflow-secondary-form">
                  <label className="field"><span>取消原因（必填）</span><input value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} disabled={submitting || submissionRecovering} maxLength={2000} placeholder="例如：資料重複／需求取消" /></label>
                  <button className="secondary-button" type="button" onClick={() => void cancelRequest()} disabled={submitting || submissionRecovering}>取消本張需求</button>
                </div> : null}
              </div>
            ) : null}
            {dataMessage ? <p className="auth-message" role="status">{dataMessage}</p> : null}
            {submitMessage ? <p className={submitMessage.includes("已送出") || submitMessage.includes("已取消") ? "success-note" : "error-box"} role="status">{submitMessage}</p> : null}
            {submissionRecovering ? <p className="auth-message" role="status">伺服器結果尚未確認；為避免重複建立，欄位暫時鎖定。請按「以相同資料查回／重試送出」。</p> : null}
          </div>
        ) : (
          <div className="tab-pane increase-tab-pane">
            <div className="increase-list" style={{ borderTop: "none", marginTop: 0, paddingTop: 0 }}>
              {/* 制服品項分類頁籤 */}
              <div
                className="increase-category-tabs"
                role="tablist"
                aria-label="制服品項分類"
                style={{
                  display: "flex",
                  gap: "6px",
                  flexWrap: "wrap",
                  marginBottom: "12px",
                  paddingBottom: "8px",
                  borderBottom: "1px solid var(--line, #e5e9ef)",
                }}
              >
                {categoryTabs.map((cat) => {
                  const isActive = categoryFilter === cat.key;
                  return (
                    <button
                      key={cat.key}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => {
                        setCategoryFilter(cat.key);
                        setIncreasePage(1);
                      }}
                      style={{
                        padding: "6px 12px",
                        borderRadius: "8px",
                        border: isActive ? "1px solid var(--accent, #d8744a)" : "1px solid #e2e8f0",
                        background: isActive ? "var(--accent, #d8744a)" : "#f8fafc",
                        color: isActive ? "#fff" : "#475569",
                        fontWeight: isActive ? 700 : 500,
                        fontSize: "13px",
                        cursor: "pointer",
                        transition: "all 0.15s ease",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                      }}
                    >
                      <span>{cat.label}</span>
                      <span
                        style={{
                          fontSize: "11px",
                          padding: "1px 5px",
                          borderRadius: "10px",
                          background: isActive ? "rgba(255, 255, 255, 0.25)" : "#e2e8f0",
                          color: isActive ? "#fff" : "#64748b",
                        }}
                      >
                        {cat.count}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* 次級篩選按鈕（性別、季節）與搜尋列 */}
              <div
                className="increase-filter-toolbar"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "10px",
                  marginBottom: "14px",
                  background: "#f8fafc",
                  padding: "8px 12px",
                  borderRadius: "8px",
                  border: "1px solid #e2e8f0",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
                  {/* 性別篩選按鈕群 */}
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>性別：</span>
                    <div style={{ display: "inline-flex", borderRadius: "6px", overflow: "hidden", border: "1px solid #cbd5e1" }}>
                      {[
                        { key: "ALL", label: "全部" },
                        { key: "MALE", label: "男" },
                        { key: "FEMALE", label: "女" },
                      ].map((g) => {
                        const active = genderFilter === g.key;
                        return (
                          <button
                            key={g.key}
                            type="button"
                            onClick={() => {
                              setGenderFilter(g.key as GenderFilterKey);
                              setIncreasePage(1);
                            }}
                            style={{
                              padding: "3px 9px",
                              fontSize: "12px",
                              border: "none",
                              borderRight: "1px solid #cbd5e1",
                              background: active ? "var(--accent, #d8744a)" : "#fff",
                              color: active ? "#fff" : "#334155",
                              fontWeight: active ? 700 : 400,
                              cursor: "pointer",
                            }}
                          >
                            {g.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 季節篩選按鈕群 */}
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>季節：</span>
                    <div style={{ display: "inline-flex", borderRadius: "6px", overflow: "hidden", border: "1px solid #cbd5e1" }}>
                      {[
                        { key: "ALL", label: "全部" },
                        { key: "SUMMER", label: "夏季" },
                        { key: "WINTER", label: "冬季" },
                      ].map((s) => {
                        const active = seasonFilter === s.key;
                        return (
                          <button
                            key={s.key}
                            type="button"
                            onClick={() => {
                              setSeasonFilter(s.key as SeasonFilterKey);
                              setIncreasePage(1);
                            }}
                            style={{
                              padding: "3px 9px",
                              fontSize: "12px",
                              border: "none",
                              borderRight: "1px solid #cbd5e1",
                              background: active ? "var(--accent, #d8744a)" : "#fff",
                              color: active ? "#fff" : "#334155",
                              fontWeight: active ? 700 : 400,
                              cursor: "pointer",
                            }}
                          >
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 尺寸篩選按鈕群 */}
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ fontSize: "12px", fontWeight: 600, color: "#64748b" }}>尺寸：</span>
                    <div style={{ display: "inline-flex", borderRadius: "6px", overflow: "hidden", border: "1px solid #cbd5e1" }}>
                      {[
                        { key: "ALL", label: "全部" },
                        ...STANDARD_UNIFORM_SIZES.map((sz) => ({ key: sz, label: sz })),
                      ].map((s) => {
                        const active = sizeFilter === s.key;
                        return (
                          <button
                            key={`increase-size-${s.key}`}
                            type="button"
                            onClick={() => {
                              setSizeFilter(s.key);
                              setIncreasePage(1);
                            }}
                            style={{
                              padding: "3px 7px",
                              fontSize: "12px",
                              border: "none",
                              borderRight: "1px solid #cbd5e1",
                              background: active ? "var(--accent, #d8744a)" : "#fff",
                              color: active ? "#fff" : "#334155",
                              fontWeight: active ? 700 : 400,
                              cursor: "pointer",
                            }}
                          >
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 重設篩選 */}
                  {categoryFilter !== "ALL" || genderFilter !== "ALL" || seasonFilter !== "ALL" || sizeFilter !== "ALL" || increaseSearch ? (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setCategoryFilter("ALL");
                        setGenderFilter("ALL");
                        setSeasonFilter("ALL");
                        setSizeFilter("ALL");
                        setIncreaseSearch("");
                        setIncreasePage(1);
                      }}
                      style={{ fontSize: "12px", color: "#64748b", padding: "2px 4px" }}
                    >
                      重設篩選
                    </button>
                  ) : null}
                </div>

                {/* 搜尋框與分頁小控制項 */}
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <input
                      type="search"
                      value={increaseSearch}
                      onChange={(event) => {
                        setIncreaseSearch(event.target.value);
                        setIncreasePage(1);
                      }}
                      placeholder="搜尋品號、品名或尺寸…"
                      disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                      style={{
                        padding: "4px 8px",
                        fontSize: "12px",
                        borderRadius: "6px",
                        border: "1px solid var(--line, #ccc)",
                        width: "180px",
                        background: "#fff",
                      }}
                      aria-label="搜尋增庫品項"
                    />
                    {increaseSearch ? (
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => {
                          setIncreaseSearch("");
                          setIncreasePage(1);
                        }}
                        style={{ fontSize: "12px", padding: "2px 4px" }}
                      >
                        清除
                      </button>
                    ) : null}
                  </div>
                  {totalIncreasePages > 1 ? (
                    <div className="button-row pagination-controls" style={{ margin: 0, gap: "4px", alignItems: "center" }}>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={currentIncreasePage <= 1 || submitting || submissionRecovering}
                        onClick={() => setIncreasePage((p) => Math.max(1, p - 1))}
                        style={{ padding: "3px 8px", fontSize: "12px" }}
                      >
                        上一頁
                      </button>
                      <span style={{ alignSelf: "center", fontSize: "12px", fontWeight: 600 }}>
                        {currentIncreasePage} / {totalIncreasePages}
                      </span>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={currentIncreasePage >= totalIncreasePages || submitting || submissionRecovering}
                        onClick={() => setIncreasePage((p) => Math.min(totalIncreasePages, p + 1))}
                        style={{ padding: "3px 8px", fontSize: "12px" }}
                      >
                        下一頁
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="subheading" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", marginBottom: "12px" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: "15px" }}>隨需求單進行增庫</h3>
                  <span style={{ fontSize: "12px", color: "var(--muted, #666)" }}>
                    尺寸選填；庫存按品號獨立計算{filteredIncreaseItems.length > 0 ? `（每頁 10 筆，目前篩選共 ${filteredIncreaseItems.length} 個品號）` : ""}
                  </span>
                </div>
              </div>

              {filteredIncreaseItems.length === 0 ? (
                <p className="empty-state" style={{ padding: "16px 0", textAlign: "center" }}>
                  查無符合目前分類或條件的品號；請調整分類頁籤、篩選條件或點擊「重設篩選」。
                </p>
              ) : null}
              {pagedIncreaseItems.map((item) => {
                const autoQty = autoBalanced.autoAdjustedItems[item.itemId] ?? 0;
                const incQty = increases[item.itemId] ?? 0;
                return (
                  <div
                    className="increase-row"
                    key={item.itemId}
                    style={{ gridTemplateColumns: "1fr auto" }}
                  >
                    <span>
                      {item.itemCode}｜{item.itemName}（{item.size || "不分尺寸"}）
                      {autoQty > 0 ? (
                        <span style={{ fontSize: "11px", color: "#0284c7", background: "#e0f2fe", padding: "1px 6px", borderRadius: "4px", marginLeft: "6px", fontWeight: 600 }}>
                          發放不足自動轉增庫 +{autoQty}
                        </span>
                      ) : null}
                      <small>
                        人資倉 {item.hrOnHand} ／總倉 {item.generalOnHand}／有效預留 {item.activeReserved}
                      </small>
                    </span>
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        border: "1px solid #93c5fd",
                        borderRadius: "6px",
                        overflow: "hidden",
                        background: "#fff",
                      }}
                    >
                      <button
                        type="button"
                        title={incQty <= 1 ? "減為 0" : "減少 1 件"}
                        disabled={incQty <= 0 || submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                        onClick={() => {
                          markDraftChanged();
                          setIncreases((current) => ({
                            ...current,
                            [item.itemId]: Math.max(0, incQty - 1),
                          }));
                        }}
                        style={{
                          width: "28px",
                          height: "28px",
                          border: "none",
                          borderRight: "1px solid #93c5fd",
                          background: incQty <= 0 ? "#f8fafc" : incQty === 1 ? "#fee2e2" : "#f0f9ff",
                          color: incQty <= 0 ? "#94a3b8" : incQty === 1 ? "#dc2626" : "#0284c7",
                          cursor: incQty <= 0 ? "not-allowed" : "pointer",
                          fontWeight: 800,
                          fontSize: "16px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 0,
                        }}
                      >
                        -
                      </button>
                      <input
                        min={0}
                        step={1}
                        type="number"
                        value={incQty}
                        onChange={(event) => {
                          markDraftChanged();
                          setIncreases((current) => ({
                            ...current,
                            [item.itemId]: Math.max(0, Number(event.target.value) || 0),
                          }));
                        }}
                        disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                        style={{
                          width: "46px",
                          height: "28px",
                          border: "none",
                          outline: "none",
                          textAlign: "center",
                          fontSize: "15px",
                          fontWeight: 700,
                          color: incQty > 0 ? "#0284c7" : "var(--muted, #666)",
                          padding: "0 2px",
                          background: "#fff",
                          borderRadius: 0,
                        }}
                        aria-label={`${item.itemCode} 增庫量`}
                      />
                      <button
                        type="button"
                        title="增加 1 件"
                        disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                        onClick={() => {
                          markDraftChanged();
                          setIncreases((current) => ({
                            ...current,
                            [item.itemId]: incQty + 1,
                          }));
                        }}
                        style={{
                          width: "28px",
                          height: "28px",
                          border: "none",
                          borderLeft: "1px solid #93c5fd",
                          background: "#f0f9ff",
                          color: "#0284c7",
                          cursor: "pointer",
                          fontWeight: 800,
                          fontSize: "16px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 0,
                        }}
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
              {totalIncreasePages > 1 ? (
                <div className="button-row pagination-controls" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px" }}>
                  <span style={{ fontSize: "13px", color: "var(--muted, #666)" }}>
                    顯示第 {(currentIncreasePage - 1) * increasePageSize + 1} 至 {Math.min(currentIncreasePage * increasePageSize, filteredIncreaseItems.length)} 筆，共 {filteredIncreaseItems.length} 筆
                  </span>
                  <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={currentIncreasePage <= 1 || submitting || submissionRecovering}
                      onClick={() => setIncreasePage((p) => Math.max(1, p - 1))}
                      style={{ padding: "4px 10px", fontSize: "13px" }}
                    >
                      上一頁
                    </button>
                    <span style={{ fontSize: "13px", fontWeight: 600 }}>
                      第 {currentIncreasePage} / {totalIncreasePages} 頁
                    </span>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={currentIncreasePage >= totalIncreasePages || submitting || submissionRecovering}
                      onClick={() => setIncreasePage((p) => Math.min(totalIncreasePages, p + 1))}
                      style={{ padding: "4px 10px", fontSize: "13px" }}
                    >
                      下一頁
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            {(submittedRequestId && !editingSubmitted && !submittedEarlyIssue) || hasDraftOperation ? (
              <div className="button-row" style={{ marginTop: "16px" }}>
                {submittedRequestId && !editingSubmitted && !submittedEarlyIssue ? <button className="secondary-button" type="button" onClick={() => { markDraftChanged(); setRequestEntryState((current) => current.kind === "submitted" ? { ...current, editing: true } : current); setSubmitMessage(""); }} disabled={submitting}>修改本張需求</button> : null}
                {hasDraftOperation ? <div className="workflow-secondary-form">
                  <label className="field"><span>取消原因（必填）</span><input value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} disabled={submitting || submissionRecovering} maxLength={2000} placeholder="例如：資料重複／需求取消" /></label>
                  <button className="secondary-button" type="button" onClick={() => void cancelRequest()} disabled={submitting || submissionRecovering}>取消本張需求</button>
                </div> : null}
              </div>
            ) : null}
            {dataMessage ? <p className="auth-message" role="status">{dataMessage}</p> : null}
            {submitMessage ? <p className={submitMessage.includes("已送出") || submitMessage.includes("已取消") ? "success-note" : "error-box"} role="status">{submitMessage}</p> : null}
            {submissionRecovering ? <p className="auth-message" role="status">伺服器結果尚未確認；為避免重複建立，欄位暫時鎖定。請按「以相同資料查回／重試送出」。</p> : null}
          </div>
        )}

        <ReturnedHrRequestPicker
          disabled={submitting || returnedDraftLoading || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
          onLoadingChange={setReturnedDraftLoading}
          onLoad={(draft) => {
            resetEntryForm();
            operationRef.current = { ...createHrRequestOperation(() => crypto.randomUUID()), draftId: draft.id };
            setRequestEntryState({ kind: "draft", requestId: draft.id });
            setDistributionDate(draft.distribution_date);
            setRequestNote(draft.note ?? "");
            setLines(draft.issueLines.map((line) => ({ lineId: crypto.randomUUID(), employeeId: line.employee_id, itemId: line.item_id, quantity: Number(line.quantity) })));
            setIncreases(Object.fromEntries(draft.increases.map((item) => [item.item_id, Number(item.increase_quantity)])));
            setSubmitMessage(`正在修改 ${draft.request_no}，退回原因：${draft.return_reason ?? "請查看退回紀錄"}。`);
          }}
        />
      </div>

      <div className="panel result-panel">
        <div className="panel-heading" style={{ flexWrap: "wrap", gap: "10px", marginBottom: "18px" }}>
          <div>
            <p className="eyebrow">04 / ITEM SUMMARY</p>
            <h2>送出前品號檢查</h2>
          </div>
          <div className="heading-actions" style={{ alignItems: "flex-end", gap: "8px" }}>
            <span className={`status-pill ${dataReadBlocked || result.error ? "danger" : "success"}`}>
              {dataReadBlocked ? "等待主檔資料" : result.error ? "不可送出" : "可送出預覽"}
            </span>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button
                className="primary-button print-button"
                type="button"
                onClick={() => void submitRequest()}
                disabled={submitting || (!submissionRecovering && (dataReadBlocked || Boolean(result.error))) || (Boolean(submittedRequestId) && !editingSubmitted)}
                style={{
                  margin: 0,
                  padding: "8px 16px",
                  fontSize: "14px",
                  whiteSpace: "nowrap",
                  height: "38px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxSizing: "border-box",
                }}
              >
                {submitting ? "送出中…" : submissionRecovering ? "以相同資料查回／重試送出" : submittedRequestId && !editingSubmitted ? submittedEarlyIssue ? "已送出並扣人資倉" : "已送出並預留" : editingSubmitted ? "保存修改並重新驗證" : hasDraftOperation ? "重試送出（先保存草稿修改）" : "建立草稿並送出"}
              </button>
              <button
                className="secondary-button print-button"
                type="button"
                onClick={() => window.print()}
                style={{
                  margin: 0,
                  padding: "8px 16px",
                  fontSize: "14px",
                  whiteSpace: "nowrap",
                  height: "38px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxSizing: "border-box",
                }}
              >
                列印 A4 預覽
              </button>
            </div>
          </div>
        </div>
        {submitMessage ? (
          <p className={submitMessage.includes("已送出") || submitMessage.includes("已取消") ? "success-note" : "auth-message"} role="status" style={{ marginBottom: "14px" }}>
            {submitMessage}
          </p>
        ) : null}
        {dataReadBlocked ? (
          <p className="empty-state">主檔資料載入後，這裡會顯示需求量、可用庫存與品號彙總。</p>
        ) : (
          <>
            {result.error && Object.keys(result.exceededErrors).length === 0 ? (
              <div className="error-box" role="alert" style={{ marginBottom: "14px" }}>
                <strong>這張需求單需要修正</strong>
                <span>{result.error}</span>
              </div>
            ) : null}
            {result.autoAdjustedItems &&
              result.summary?.summaries.some((s) => {
                const autoQty = result.autoAdjustedItems?.[s.item.itemId] ?? 0;
                const exceeded = Boolean(result.exceededErrors?.[s.item.itemId]);
                return autoQty > 0 && s.item.generalOnHand > 0 && !exceeded;
              }) && (
              <div
                style={{
                  background: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  borderRadius: "8px",
                  padding: "10px 12px",
                  marginBottom: "12px",
                  fontSize: "13px",
                  color: "#166534",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "8px",
                  lineHeight: "1.4",
                }}
              >
                <span style={{ fontSize: "16px", lineHeight: "1" }}>💡</span>
                <div>
                  <strong>智慧庫存適配：部分品項已自動轉增庫調撥</strong>
                  <div style={{ fontSize: "12px", color: "#15803d", marginTop: "2px" }}>
                    所填發放量超過人資倉現有量之部分，已自動轉為向總倉申請增庫調撥，兩倉合計充足可順暢送單！
                  </div>
                </div>
              </div>
            )}
            {(!result.summary || result.summary.summaries.length === 0) && (
              <p className="empty-state">尚未填寫任何發放或增庫數量。請在左側填寫申請數量。</p>
            )}
            <div className="summary-list" style={{ marginTop: 0, borderTop: "none" }}>
              {result.summary?.summaries.map((summary) => {
                const autoAdjustedQty = result.autoAdjustedItems?.[summary.item.itemId] ?? 0;
                const itemExceededError = result.exceededErrors?.[summary.item.itemId];
                const isExceeded = Boolean(itemExceededError);
                const itemDeptLabels = Array.from(
                  new Set(
                    visibleLines
                      .filter((l) => l.itemId === summary.item.itemId && l.quantity > 0 && l.departmentCode)
                      .map((l) => {
                        for (const row of DEPARTMENT_BUTTON_ROWS) {
                          const found = row.find((d) => d.code === l.departmentCode);
                          if (found) return found.display;
                        }
                        return resolveInstitutionInfo(l.departmentCode).shortName;
                      })
                  )
                );

                return (
                  <div
                    className="summary-row"
                    key={summary.item.itemId}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "stretch",
                      gap: "8px",
                      padding: "12px 10px",
                      borderRadius: "8px",
                      border: isExceeded ? "1.5px solid #f87171" : "1px solid transparent",
                      background: isExceeded ? "#fff5f5" : "transparent",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", flex: 1, minWidth: 0 }}>
                        {itemDeptLabels.map((dept) => (
                          <span
                            key={dept}
                            style={{
                              display: "inline-block",
                              fontSize: "14px",
                              fontWeight: 600,
                              background: "var(--accent, #1a73e8)",
                              color: "#fff",
                              padding: "3px 8px",
                              borderRadius: "4px",
                              lineHeight: "1.3",
                            }}
                          >
                            {dept}
                          </span>
                        ))}
                        {itemDeptLabels.length === 0 && (
                          <span
                            style={{
                              display: "inline-block",
                              fontSize: "14px",
                              fontWeight: 600,
                              background: "#f1f5f9",
                              color: "#64748b",
                              padding: "3px 8px",
                              borderRadius: "4px",
                              lineHeight: "1.3",
                            }}
                          >
                            增庫
                          </span>
                        )}
                        <strong style={{ fontSize: "18px", color: "var(--ink)", fontWeight: 800, letterSpacing: "-0.01em" }}>
                          {summary.item.itemCode}
                        </strong>
                        <span style={{ fontSize: "16px", fontWeight: 700, color: "var(--ink)" }}>
                          {summary.item.itemName}
                          <span style={{ fontSize: "15px", fontWeight: 500, color: "var(--muted)", marginLeft: "4px" }}>
                            ／{summary.item.size || "不分尺寸"}
                          </span>
                        </span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
                        {/* 發放數量調整 */}
                        {summary.issueQuantity > 0 && (
                          <div style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                            <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--ink)" }}>發放</span>
                            <div
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                border: "1px solid #cbd5e1",
                                borderRadius: "6px",
                                overflow: "hidden",
                                background: "#fff",
                              }}
                            >
                              <button
                                type="button"
                                title={summary.issueQuantity <= 1 ? "減為 0（移除品項）" : "減少 1 件"}
                                disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                                onClick={() => handleSummaryIssueQtyChange(summary.item.itemId, -1, true)}
                                style={{
                                  width: "28px",
                                  height: "28px",
                                  border: "none",
                                  borderRight: "1px solid #cbd5e1",
                                  background: summary.issueQuantity <= 1 ? "#fee2e2" : "#f8fafc",
                                  color: summary.issueQuantity <= 1 ? "#dc2626" : "var(--ink)",
                                  cursor: "pointer",
                                  fontWeight: 800,
                                  fontSize: "16px",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  padding: 0,
                                }}
                              >
                                -
                              </button>
                              <input
                                type="number"
                                min={0}
                                value={summary.issueQuantity}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value, 10);
                                  handleSummaryIssueQtyChange(summary.item.itemId, isNaN(val) || val <= 0 ? 0 : val, false);
                                }}
                                disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                                style={{
                                  width: "46px",
                                  height: "28px",
                                  border: "none",
                                  textAlign: "center",
                                  fontSize: "15px",
                                  fontWeight: 700,
                                  color: "var(--ink)",
                                  padding: "0 2px",
                                  background: "#fff",
                                }}
                                aria-label={`${summary.item.itemCode} 發放量調整`}
                              />
                              <button
                                type="button"
                                title="增加 1 件"
                                disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                                onClick={() => handleSummaryIssueQtyChange(summary.item.itemId, 1, true)}
                                style={{
                                  width: "28px",
                                  height: "28px",
                                  border: "none",
                                  borderLeft: "1px solid #cbd5e1",
                                  background: "#f8fafc",
                                  color: "var(--ink)",
                                  cursor: "pointer",
                                  fontWeight: 800,
                                  fontSize: "16px",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  padding: 0,
                                }}
                              >
                                +
                              </button>
                            </div>
                          </div>
                        )}

                        {/* 增庫數量調整 */}
                        {summary.increaseQuantity > 0 && (
                          <div style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                            <span style={{ fontSize: "14px", fontWeight: 700, color: "#0284c7" }}>增庫</span>
                            <div
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                border: "1px solid #93c5fd",
                                borderRadius: "6px",
                                overflow: "hidden",
                                background: "#fff",
                              }}
                            >
                              <button
                                type="button"
                                title={summary.increaseQuantity <= 1 ? "減為 0（移除增庫）" : "減少 1 件"}
                                disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                                onClick={() => handleSummaryIncreaseQtyChange(summary.item.itemId, -1, true)}
                                style={{
                                  width: "28px",
                                  height: "28px",
                                  border: "none",
                                  borderRight: "1px solid #93c5fd",
                                  background: summary.increaseQuantity <= 1 ? "#fee2e2" : "#f0f9ff",
                                  color: summary.increaseQuantity <= 1 ? "#dc2626" : "#0284c7",
                                  cursor: "pointer",
                                  fontWeight: 800,
                                  fontSize: "16px",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  padding: 0,
                                }}
                              >
                                -
                              </button>
                              <input
                                type="number"
                                min={0}
                                value={summary.increaseQuantity}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value, 10);
                                  handleSummaryIncreaseQtyChange(summary.item.itemId, isNaN(val) || val <= 0 ? 0 : val, false);
                                }}
                                disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                                style={{
                                  width: "46px",
                                  height: "28px",
                                  border: "none",
                                  textAlign: "center",
                                  fontSize: "15px",
                                  fontWeight: 700,
                                  color: "#0284c7",
                                  padding: "0 2px",
                                  background: "#fff",
                                }}
                                aria-label={`${summary.item.itemCode} 增庫量調整`}
                              />
                              <button
                                type="button"
                                title="增加 1 件"
                                disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                                onClick={() => handleSummaryIncreaseQtyChange(summary.item.itemId, 1, true)}
                                style={{
                                  width: "28px",
                                  height: "28px",
                                  border: "none",
                                  borderLeft: "1px solid #93c5fd",
                                  background: "#f0f9ff",
                                  color: "#0284c7",
                                  cursor: "pointer",
                                  fontWeight: 800,
                                  fontSize: "16px",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  padding: 0,
                                }}
                              >
                                +
                              </button>
                            </div>
                          </div>
                        )}

                        {/* 自動轉增庫標記 */}
                        {autoAdjustedQty > 0 && summary.item.generalOnHand > 0 && !isExceeded && (
                          <span style={{ color: "#0284c7", fontWeight: 600, fontSize: "13px", background: "#f0f9ff", padding: "3px 7px", borderRadius: "4px", border: "1px solid #bae6fd" }}>
                            含轉增庫 {autoAdjustedQty}
                          </span>
                        )}

                        {/* 快速移除按鈕 */}
                        <button
                          type="button"
                          title="移除此品項（數量歸零）"
                          disabled={submitting || submissionRecovering || (Boolean(submittedRequestId) && !editingSubmitted)}
                          onClick={() => handleRemoveItemCompletely(summary.item.itemId)}
                          style={{
                            border: "1px solid #fecaca",
                            background: "#fff5f5",
                            color: "#dc2626",
                            borderRadius: "6px",
                            padding: "5px 9px",
                            fontSize: "13px",
                            fontWeight: 600,
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            lineHeight: "1",
                            transition: "all 0.15s ease",
                          }}
                        >
                          <span>🗑️</span>
                          <span>移除</span>
                        </button>
                      </div>
                    </div>
                    {/* 若超出可申請量，直接在缺少品項下方提醒已超出申請量請調整數量 */}
                    {isExceeded && (
                      <div
                        style={{
                          fontSize: "14px",
                          color: "#b91c1c",
                          background: "#fee2e2",
                          padding: "8px 12px",
                          borderRadius: "6px",
                          marginTop: "2px",
                          border: "1px solid #fca5a5",
                          fontWeight: 700,
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                          lineHeight: "1.4",
                        }}
                      >
                        <span style={{ fontSize: "16px" }}>⚠️</span>
                        <span>
                          {itemExceededError}（現有兩倉可用量僅 {summary.availableToRequest} 件），已超出申請量，請調整數量或直接點擊「移除」
                        </span>
                      </div>
                    )}
                    {autoAdjustedQty > 0 && summary.item.generalOnHand > 0 && !isExceeded && (
                      <div style={{ fontSize: "13px", color: "#0369a1", background: "#f0f9ff", padding: "6px 10px", borderRadius: "5px", marginTop: "2px", border: "1px solid #bae6fd" }}>
                        💡 人資倉現貨僅 {summary.item.hrOnHand} 件，缺額 {summary.increaseQuantity} 件已自動轉為總倉增庫調撥
                      </div>
                    )}
                    <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "8px" }}>
                      <strong style={{ fontSize: "15px", fontWeight: 700, color: isExceeded ? "#dc2626" : summary.requestedTransferQuantity > 0 ? "var(--accent)" : "inherit" }}>
                        調庫 {summary.requestedTransferQuantity}／兩倉總可用 {summary.availableToRequest}
                        {isExceeded && <span style={{ marginLeft: "6px", color: "#dc2626" }}>（超出可用量）</span>}
                      </strong>
                    </div>
                  </div>
                );
              })}
            </div>
            {previewMode && (
              <p className="success-note">
                這是本機測試資料的送出前預覽；設定 Supabase env 並登入後才可建立正式需求。
              </p>
            )}
            <div className="workbench-bottom-metrics">
              <Metric label="發放總量" value={result.summary?.totalIssueQuantity ?? 0} compact />
              <Metric label="增庫總量" value={result.summary?.totalIncreaseQuantity ?? 0} compact />
              <Metric
                label="總倉調庫需求"
                value={result.summary?.totalRequestedTransferQuantity ?? 0}
                compact
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value, compact }: { label: string; value: number; compact?: boolean }) {
  if (compact) {
    return (
      <div
        className="metric compact-metric"
        style={{
          padding: "8px 12px",
          borderRadius: "10px",
          display: "grid",
          gap: "3px",
          background: "#f8fafc",
          border: "1px solid var(--line, #e2e8f0)",
        }}
      >
        <span style={{ fontSize: "12px", color: "var(--muted, #64748b)", fontWeight: 500 }}>{label}</span>
        <strong style={{ fontSize: "18px", letterSpacing: "normal", color: "var(--ink, #1e293b)", fontWeight: 700 }}>{value}</strong>
      </div>
    );
  }
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
