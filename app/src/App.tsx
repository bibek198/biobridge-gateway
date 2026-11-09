import { AppStoreProvider } from "./state/appStore";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { ConnectPanel } from "./components/ConnectPanel";
import { LiveDataPanel } from "./components/LiveDataPanel";
import { PipelinePanel } from "./components/PipelinePanel";
import { RecordingsPanel } from "./components/RecordingsPanel";
import { AlertLog } from "./components/AlertLog";
import { SyncPanel } from "./components/SyncPanel";

function App() {
  return (
    <AppStoreProvider>
      <Layout
        title="BioBridge"
        subtitle="Team B19: descriptor-driven gateway for heterogeneous biomedical edge devices"
        tabs={[
          { id: "connect", label: "Devices", content: <ErrorBoundary><ConnectPanel /></ErrorBoundary> },
          { id: "live", label: "Live Data", content: <ErrorBoundary><LiveDataPanel /></ErrorBoundary> },
          { id: "sync", label: "Clock Sync", content: <ErrorBoundary><SyncPanel /></ErrorBoundary> },
          { id: "pipeline", label: "Compute Pipeline", content: <ErrorBoundary><PipelinePanel /></ErrorBoundary> },
          { id: "recordings", label: "Recordings", content: <ErrorBoundary><RecordingsPanel /></ErrorBoundary> },
          { id: "alerts", label: "Alert Log", content: <ErrorBoundary><AlertLog /></ErrorBoundary> },
        ]}
      />
    </AppStoreProvider>
  );
}

export default App;
