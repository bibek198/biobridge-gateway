import type { ReactNode } from "react";
import { AppStoreProvider } from "./state/appStore";
import { useRoute, type PageId } from "./state/router";
import { AppShell } from "./components/AppShell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ConfirmProvider } from "./components/ui/ConfirmDialog";
import { OverviewPage } from "./pages/OverviewPage";
import { DevicesPage } from "./pages/DevicesPage";
import { LiveDataPage } from "./pages/LiveDataPage";
import { AlertsPage } from "./pages/AlertsPage";
import { SyncPage } from "./pages/SyncPage";
import { PlacementPage } from "./pages/PlacementPage";
import { RecordingsPage } from "./pages/RecordingsPage";
import { PipelinePage } from "./pages/PipelinePage";
import { AddDevicePage } from "./pages/AddDevicePage";
import { DescriptorsPage } from "./pages/DescriptorsPage";
import { VerificationPage } from "./pages/VerificationPage";

function page(id: PageId, param: string | null): ReactNode {
  switch (id) {
    case "overview":
      return <OverviewPage />;
    case "devices":
      return <DevicesPage param={param} />;
    case "live":
      return <LiveDataPage />;
    case "alerts":
      return <AlertsPage />;
    case "sync":
      return <SyncPage />;
    case "placement":
      return <PlacementPage />;
    case "recordings":
      return <RecordingsPage param={param} />;
    case "pipeline":
      return <PipelinePage />;
    case "add":
      return <AddDevicePage />;
    case "descriptors":
      return <DescriptorsPage param={param} />;
    case "verification":
      return <VerificationPage />;
  }
}

function Routed() {
  const { page: id, param } = useRoute();
  return (
    <AppShell page={id}>
      {/* keyed so a crash on one page does not stick to the next */}
      <ErrorBoundary key={`${id}/${param ?? ""}`}>{page(id, param)}</ErrorBoundary>
    </AppShell>
  );
}

function App() {
  return (
    <AppStoreProvider>
      <ConfirmProvider>
        <Routed />
      </ConfirmProvider>
    </AppStoreProvider>
  );
}

export default App;
