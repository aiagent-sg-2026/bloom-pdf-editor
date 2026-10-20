'use client';

import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { TOOLS, type EditorTool } from '../types';

interface ToolsSidebarProps {
  activeTool: EditorTool;
  setActiveTool: (tool: EditorTool) => void;
  highlightColor: string;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  isPanelOpen?: boolean;
  onTogglePanel?: () => void;
  isMobile?: boolean;
}

const TOOL_COLORS: Record<string, string> = {
  select: '#38BDF8',     // Sky Blue
  text: '#3B82F6',       // Royal Blue
  addtext: '#3B82F6',    // Royal Blue
  highlight: '#F59E0B',  // Amber Yellow
  draw: '#A855F7',       // Purple / Violet
  erase: '#FF66C4',      // Vibrant Eraser Pink
  watermark: '#238C80',  // Paperloom jade
  redact: '#EF4444',     // Redact Red
  sign: '#3B82F6',       // Royal Blue Signature
  link: '#3B82F6',       // Link Blue
  security: '#10B981',   // Emerald Green Security
};

function getAccessibleTextColor(hexColor: string): string {
  const c = hexColor.replace('#', '');
  if (c.length === 6) {
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (luminance > 0.65) {
      return '#B45309'; // Rich dark amber for yellow/light colors
    }
  }
  return hexColor;
}

export function ToolsSidebar({
  activeTool,
  setActiveTool,
  highlightColor,
  isCollapsed: propIsCollapsed,
  onToggleCollapse,
  isPanelOpen = true,
  onTogglePanel,
  isMobile = false,
}: ToolsSidebarProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const isCollapsed = propIsCollapsed ?? internalCollapsed;

  const toggleCollapse = () => {
    if (onToggleCollapse) {
      onToggleCollapse();
    } else {
      setInternalCollapsed(!internalCollapsed);
    }
  };

  // Z_LAYERS.chrome (100); nested tooltips use Z_LAYERS.dropdown (200).
  /* ── Mobile: horizontal bottom strip ── */
  if (isMobile) {
    return (
      <aside className="fixed bottom-0 left-0 right-0 z-[100] bg-panel/95 backdrop-blur-md border-t border-app shadow-[0_-4px_24px_rgba(0,0,0,0.12)]">
        <div className="flex items-center gap-1 px-2 py-1.5 overflow-x-auto scrollbar-hide">
          {TOOLS.map((tool) => {
            const isActive = activeTool === tool.id;
            const isHighlight = tool.id === 'highlight';
            const rawAccentColor = isHighlight ? (highlightColor || '#F59E0B') : (TOOL_COLORS[tool.id] ?? '#238C80');
            const labelColor = tool.id === 'watermark' ? 'var(--accent)' : getAccessibleTextColor(rawAccentColor);

            return (
              <button
                key={tool.id}
                onClick={() => {
                  setActiveTool(tool.id);
                  if (!isPanelOpen && onTogglePanel) {
                    onTogglePanel();
                  }
                }}
                className={`
                  flex flex-col items-center justify-center gap-0.5 rounded-xl px-2.5 py-1.5 min-w-[44px]
                  transition-all duration-200 relative border shrink-0
                  ${isActive 
                    ? 'border-app-strong shadow-sm' 
                    : 'border-transparent'
                  }
                `}
                style={{
                  backgroundColor: isActive ? `${rawAccentColor}1C` : undefined,
                  color: isActive ? labelColor : undefined,
                }}
                title={tool.label}
              >
                <tool.icon size={18} />
                <span className="text-[8px] font-medium leading-none">{tool.label}</span>
                {isActive && (
                  <div 
                    className="absolute bottom-0 left-1/4 right-1/4 h-0.5 rounded-t-full"
                    style={{ backgroundColor: rawAccentColor }}
                  />
                )}
              </button>
            );
          })}

          {/* Panel toggle on mobile strip */}
          {onTogglePanel && (
            <button
              onClick={onTogglePanel}
              title={isPanelOpen ? 'Hide options' : 'Show options'}
              className={`
                flex items-center justify-center rounded-xl p-2 min-w-[44px] border transition-all duration-200 shrink-0
                ${isPanelOpen 
                  ? 'bg-panel-elevated/80 border-app text-app-muted'
                  : 'bg-bloom-100 border-accent/40 text-accent'
                }
              `}
            >
              {isPanelOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>
          )}
        </div>
      </aside>
    );
  }

  /* ── Desktop: vertical left sidebar (original) ── */
  return (
    <aside 
      className={`
        ${isCollapsed ? 'w-12' : 'w-16'} 
        bg-panel/95 backdrop-blur-md border-r border-app flex flex-col items-center pt-3 pb-3 gap-2 
        shrink-0 z-[100] relative transition-all duration-300
        shadow-[4px_0_24px_rgba(0,0,0,0.08)] min-h-0 h-full overflow-hidden
      `}
    >
      <div className="flex-1 flex flex-col gap-2 w-full px-1.5 overflow-y-auto overflow-x-hidden min-h-0 py-1">
        {TOOLS.map((tool) => {
          const isActive = activeTool === tool.id;
          const isHighlight = tool.id === 'highlight';
          const rawAccentColor = isHighlight ? (highlightColor || '#F59E0B') : (TOOL_COLORS[tool.id] ?? '#238C80');
          const accentColor = rawAccentColor;
          const labelColor = tool.id === 'watermark' ? 'var(--accent)' : getAccessibleTextColor(rawAccentColor);

          return (
            <div key={tool.id} className="relative group w-full overflow-visible">
              <button
                onClick={() => {
                  setActiveTool(tool.id);
                  // Auto re-open properties panel when choosing a tool if closed
                  if (!isPanelOpen && onTogglePanel) {
                    onTogglePanel();
                  }
                }}
                className={`
                  w-full aspect-square flex flex-col items-center justify-center gap-1 rounded-2xl
                  transition-all duration-200 relative border
                  ${isActive 
                    ? 'border-app-strong shadow-md scale-[1.04]' 
                    : 'border-transparent hover:bg-panel-elevated/80 hover:text-app'
                  }
                `}
                style={{
                  backgroundColor: isActive ? `${accentColor}1C` : undefined,
                  color: isActive ? labelColor : undefined,
                }}
              >
                <div className={`transition-transform duration-200 ${isActive ? 'scale-110' : 'group-hover:scale-110'}`}>
                  <tool.icon size={isCollapsed ? 18 : 20} />
                </div>
                {isActive && (
                  <div 
                    className="absolute left-0 top-1/4 bottom-1/4 w-1 rounded-r-full shadow-sm"
                    style={{ backgroundColor: accentColor }}
                  />
                )}
              </button>

              {/* Floating Tooltip styled with tool's own color */}
              <div 
                className="
                  absolute left-full top-1/2 -translate-y-1/2 ml-3.5 px-3 py-1.5 
                  rounded-xl bg-panel-elevated/98 backdrop-blur-xl border shadow-2xl z-[200]
                  pointer-events-none opacity-0 invisible group-hover:opacity-100 group-hover:visible
                  transition-all duration-200 flex items-center gap-2.5 whitespace-nowrap text-xs font-semibold
                "
                style={{
                  borderColor: `${accentColor}70`,
                  boxShadow: `0 10px 30px -4px ${accentColor}35`,
                }}
              >
                <span style={{ color: labelColor }}>{tool.label}</span>
                <span 
                  className="px-1.5 py-0.5 rounded-md text-[10px] font-mono border font-bold"
                  style={{
                    backgroundColor: `${accentColor}20`,
                    borderColor: `${accentColor}50`,
                    color: labelColor,
                  }}
                >
                  {tool.shortcut}
                </span>
                {/* Caret */}
                <div 
                  className="absolute right-full top-1/2 -translate-y-1/2 border-[5px] border-transparent"
                  style={{ borderRightColor: `${accentColor}70` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Control Buttons (Hide/Show Panel & Shrink/Expand Tools) */}
      <div className="flex flex-col gap-1.5 items-center w-full px-1.5 mt-auto">
        {/* Hide / Show Properties Side Panel Toggle Button */}
        {onTogglePanel && (
          <button
            onClick={onTogglePanel}
            title={isPanelOpen ? 'Hide options panel' : 'Show options panel'}
            className={`
              w-8 h-8 flex items-center justify-center rounded-xl border transition-all duration-200
              ${isPanelOpen 
                ? 'bg-panel-elevated/80 border-app text-app-muted hover:text-app hover:border-app-strong'
                : 'bg-bloom-100 border-accent/40 text-accent hover:bg-bloom-100/80 shadow-md'
              }
            `}
          >
            {isPanelOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
        )}

        {/* Shrink / Expand Tools Sidebar Toggle Button */}
        <button
          onClick={toggleCollapse}
          title={isCollapsed ? 'Expand toolbar' : 'Shrink toolbar'}
          className="w-8 h-8 flex items-center justify-center rounded-xl bg-panel-elevated/60 border border-app text-app-muted hover:text-app hover:border-app-strong transition-all duration-200"
        >
          {isCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        </button>
      </div>
    </aside>
  );
}

