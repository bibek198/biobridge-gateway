import { useState, type ReactNode } from "react";

export type Tab = { id: string; label: string; content: ReactNode };

export function Layout({ tabs, title, subtitle }: { tabs: Tab[]; title: string; subtitle: string }) {
  const [activeTab, setActiveTab] = useState(tabs[0]?.id);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <nav>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={tab.id === activeTab ? "nav-item active" : "nav-item"}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="content">{tabs.find((t) => t.id === activeTab)?.content}</main>
    </div>
  );
}
