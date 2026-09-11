import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const onboardingRoot = join(root, "docs", "deployment", "onboarding");

function read(path: string) {
  return readFileSync(path, "utf8");
}

describe("production onboarding contract", () => {
  it("keeps every durable-import CSV template aligned with the canonical worker headers", () => {
    const expectedHeaders: Record<string, string> = {
      "institutions.csv": "code,name,isActive",
      "departments.csv": "institutionCode,code,name,isActive",
      "uniform-items.csv": "code,name,unit,size,category,season,isActive",
      "suppliers.csv": "supplierCode,name,defaultCurrency,isActive",
      "supplier-items.csv": "supplierCode,itemCode,minimumOrderQuantity,supplierItemCode,isActive",
      "employees.csv": "employeeNo,name,institutionCode,departmentCode,employmentStatus,jobTitle,hireDate,terminationDate,note",
      "opening-balances.csv": "warehouseCode,itemCode,quantity",
    };

    for (const [filename, header] of Object.entries(expectedHeaders)) {
      const contents = read(join(onboardingRoot, "templates", filename));
      expect(contents.split(/\r?\n/, 1)[0]).toBe(header);
    }
  });

  it("covers every README external production dependency with a blank onboarding checklist", () => {
    const repositoryReadme = read(join(root, "README.md"));
    const onboardingReadme = read(join(onboardingRoot, "README.md"));
    const externalAcceptance = read(join(onboardingRoot, "external-acceptance.md"));
    const formalAccounts = read(join(onboardingRoot, "formal-accounts.md"));

    expect(repositoryReadme).toContain("docs/deployment/onboarding/");
    expect(onboardingReadme).toContain("external-acceptance.md");
    expect(formalAccounts).toContain("DEMAND_COORDINATOR");
    expect(formalAccounts).toContain("institutionCode");
    expect(formalAccounts).toContain("departmentCode");

    for (const required of [
      "鼎新 ERP 成功匯入樣本",
      "公司抬頭",
      "Logo",
      "異地備份",
      "第一位加密金鑰保管人",
      "第二位加密金鑰保管人",
      "RPO",
      "RTO",
      "三年容量",
      "正式保存年限",
      "GitHub repository owner",
      "Vercel project owner",
      "Supabase production project owner",
    ]) {
      expect(externalAcceptance).toContain(required);
    }

    expect(externalAcceptance).toContain("不要把真實聯絡方式");
    expect(externalAcceptance).toContain("不要在本清單保存 recovery code");
  });
});
