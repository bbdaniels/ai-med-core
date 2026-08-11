import { useRef, useEffect, useState } from 'react';

interface Tab {
  id: string;
  label: string;
  icon?: string;
}

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  onTabChange: (id: string) => void;
  scrollable?: boolean;
  className?: string;
}

export default function TabBar({ tabs, activeTabId, onTabChange, scrollable, className }: TabBarProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);

  useEffect(() => {
    if (!scrollable) return;
    const el = stripRef.current;
    if (!el) return;

    const check = () => {
      setHasOverflow(el.scrollWidth > el.clientWidth + 1);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollable, tabs]);

  // Keep the active tab's button visible in the scrollable strip — a tab can be
  // activated programmatically (e.g. a document reference clicked in chat) while
  // its button sits scrolled out of view.
  useEffect(() => {
    if (!scrollable) return;
    const active = stripRef.current?.querySelector('.tab-bar-button.active');
    active?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [scrollable, activeTabId]);

  return (
    <div
      ref={stripRef}
      className={`tab-bar ${scrollable ? 'tab-bar-scrollable' : ''} ${hasOverflow ? 'has-overflow' : ''} ${className || ''}`}
      role="tablist"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`tab-bar-button ${tab.id === activeTabId ? 'active' : ''}`}
          role="tab"
          aria-selected={tab.id === activeTabId}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.icon && <span className="tab-bar-icon">{tab.icon}</span>}
          {tab.label}
        </button>
      ))}
    </div>
  );
}
