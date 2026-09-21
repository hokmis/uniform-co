import SsoLoadingShell from "../SsoLoadingShell";

export default function AppLoading() {
  return (
    <SsoLoadingShell
      title="正在開啟工作區"
      message="SSO 已確認，正在載入工作區資料，請稍候…"
    />
  );
}
