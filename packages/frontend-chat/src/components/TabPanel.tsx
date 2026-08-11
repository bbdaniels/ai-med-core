import React from 'react';

interface TabPanelProps {
  activeTabId: string;
  children: React.ReactNode;
}

export default function TabPanel({ activeTabId, children }: TabPanelProps) {
  return (
    <div className="tab-panel-container">
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return null;
        const tabId = (child.props as Record<string, unknown>)['data-tab-id'] as string;
        const isActive = tabId === activeTabId;
        return (
          <div
            className={`tab-panel ${isActive ? 'tab-panel-active' : ''}`}
            style={{ display: isActive ? 'flex' : 'none' }}
            role="tabpanel"
            aria-hidden={!isActive}
          >
            {child}
          </div>
        );
      })}
    </div>
  );
}
