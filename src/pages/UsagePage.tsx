import { useState, useEffect, useCallback } from 'react';
import { BarChart3, Zap, ArrowDownLeft, ArrowUpRight, DollarSign } from 'lucide-react';
import type { UsageStats, UsageFilter, AgentUsageStats } from '@/types';

type Period = 'today' | 'yesterday' | 'week' | 'month' | 'custom';
type Tab = 'model' | 'agent';

function getPeriodFilter(period: Period, customFrom?: string, customTo?: string): UsageFilter {
  const now = new Date();

  if (period === 'custom') {
    return {
      from: customFrom
        ? new Date(customFrom).toISOString()
        : new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      to: customTo
        ? new Date(customTo + 'T23:59:59').toISOString()
        : now.toISOString(),
    };
  }

  const from = new Date();

  switch (period) {
    case 'today':
      from.setHours(0, 0, 0, 0);
      break;
    case 'yesterday': {
      from.setDate(now.getDate() - 1);
      from.setHours(0, 0, 0, 0);
      const to = new Date(from);
      to.setHours(23, 59, 59, 999);
      return { from: from.toISOString(), to: to.toISOString() };
    }
    case 'week':
      from.setDate(now.getDate() - 7);
      break;
    case 'month':
      from.setFullYear(now.getFullYear(), now.getMonth(), 1);
      from.setHours(0, 0, 0, 0);
      break;
  }

  return {
    from: from.toISOString(),
    to: now.toISOString(),
  };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function UsagePage() {
  const [period, setPeriod] = useState<Period>('month');
  const [activeTab, setActiveTab] = useState<Tab>('model');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [agentStats, setAgentStats] = useState<AgentUsageStats | null>(null);
  const [loading, setLoading] = useState(true);

  const loadStats = useCallback(async () => {
    setLoading(true);
    try {
      const filter = getPeriodFilter(period, customFrom, customTo);
      const data = await window.lionclaw.usage.getStats(filter);
      setStats(data);

      if (activeTab === 'agent') {
        const agentData = await window.lionclaw.usage.getAgentStats(filter);
        setAgentStats(agentData);
      }
    } catch (err) {
      console.error('Failed to load usage stats:', err);
    } finally {
      setLoading(false);
    }
  }, [period, activeTab, customFrom, customTo]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const totalTokens = stats ? stats.totalInputTokens + stats.totalOutputTokens : 0;
  const inputPct = totalTokens > 0 ? Math.round((stats?.totalInputTokens || 0) / totalTokens * 100) : 0;
  const outputPct = totalTokens > 0 ? 100 - inputPct : 0;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <BarChart3 size={20} className="text-amber-500" />
          <h1 className="text-lg font-semibold text-zinc-100">Usage</h1>
        </div>
        {/* Period filter */}
        <div className="flex items-center gap-2">
          <div className="flex gap-1 bg-zinc-900 rounded-lg p-0.5">
            {([
              { key: 'today', label: 'Hoje' },
              { key: 'yesterday', label: 'Ontem' },
              { key: 'week', label: 'Semana' },
              { key: 'month', label: 'Mes' },
              { key: 'custom', label: 'Personalizado' },
            ] as const).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setPeriod(key)}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  period === key
                    ? 'bg-amber-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {period === 'custom' && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300"
              />
              <span className="text-zinc-500 text-xs">ate</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300"
              />
            </div>
          )}
        </div>
      </div>

      <div className="p-6 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : stats ? (
          <>
            {/* Metric cards */}
            <div className="grid grid-cols-4 gap-4">
              <MetricCard
                icon={<Zap size={16} />}
                label="Total Tokens"
                value={formatTokens(totalTokens)}
                sub={`${stats.totalRequests} requests`}
              />
              <MetricCard
                icon={<ArrowDownLeft size={16} />}
                label="Input Tokens"
                value={formatTokens(stats.totalInputTokens)}
                sub={`${inputPct}% do total`}
              />
              <MetricCard
                icon={<ArrowUpRight size={16} />}
                label="Output Tokens"
                value={formatTokens(stats.totalOutputTokens)}
                sub={`${outputPct}% do total`}
              />
              <MetricCard
                icon={<DollarSign size={16} />}
                label="Custo Estimado"
                value={formatCost(stats.totalCostUsd)}
                sub={`${formatCost(stats.totalCostUsd / Math.max(stats.totalRequests, 1))}/req`}
              />
            </div>

            {/* Tabs */}
            <div className="flex gap-1 bg-zinc-900/50 rounded-lg p-0.5 w-fit">
              <button
                onClick={() => setActiveTab('model')}
                className={`px-4 py-1.5 text-xs rounded-md transition-colors ${
                  activeTab === 'model' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Por Modelo
              </button>
              <button
                onClick={() => setActiveTab('agent')}
                className={`px-4 py-1.5 text-xs rounded-md transition-colors ${
                  activeTab === 'agent' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Por Agente
              </button>
            </div>

            {/* Chart area */}
            {stats.byDay.length > 0 && (() => {
              const days = stats.byDay.slice().reverse().slice(-30);
              const maxTokens = Math.max(...days.map(d => d.inputTokens + d.outputTokens), 1);
              const chartHeight = 220; // px
              // Y-axis labels: 5 ticks
              const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(maxTokens * f));

              return (
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-medium text-zinc-300">Tokens por dia</h3>
                    <div className="flex items-center gap-3 text-[10px] text-zinc-500">
                      <span className="flex items-center gap-1">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-500" /> Output
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-500/30" /> Input
                      </span>
                    </div>
                  </div>
                  <div className="flex">
                    {/* Y-axis labels */}
                    <div className="flex flex-col justify-between pr-2 text-[10px] text-zinc-600 shrink-0" style={{ height: `${chartHeight}px` }}>
                      {yTicks.slice().reverse().map((v, i) => (
                        <span key={i} className="text-right min-w-[40px]">{formatTokens(v)}</span>
                      ))}
                    </div>
                    {/* Bars */}
                    <div className="flex-1 flex items-end gap-[3px] relative border-l border-b border-zinc-800/50" style={{ height: `${chartHeight}px` }}>
                      {/* Horizontal grid lines */}
                      {[0.25, 0.5, 0.75].map(f => (
                        <div
                          key={f}
                          className="absolute left-0 right-0 border-t border-zinc-800/30"
                          style={{ bottom: `${f * 100}%` }}
                        />
                      ))}
                      {days.map((day) => {
                        const total = day.inputTokens + day.outputTokens;
                        const barHeight = Math.max(total > 0 ? (total / maxTokens) * chartHeight : 0, total > 0 ? 6 : 0);
                        const outputH = total > 0 ? (day.outputTokens / total) * barHeight : 0;
                        const inputH = barHeight - outputH;

                        return (
                          <div
                            key={day.date}
                            className="flex-1 flex flex-col justify-end group relative"
                            style={{ height: `${chartHeight}px` }}
                          >
                            {/* Tooltip */}
                            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10">
                              <div className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[10px] text-zinc-300 whitespace-nowrap shadow-lg">
                                <div className="font-medium">{day.date}</div>
                                <div>Total: {formatTokens(total)}</div>
                                <div>Input: {formatTokens(day.inputTokens)}</div>
                                <div>Output: {formatTokens(day.outputTokens)}</div>
                                <div className="text-amber-400">{formatCost(day.costUsd)}</div>
                              </div>
                            </div>
                            <div className="w-full flex flex-col rounded-t overflow-hidden" style={{ height: `${barHeight}px` }}>
                              <div className="bg-amber-500 rounded-t" style={{ height: `${outputH}px` }} />
                              <div className="bg-amber-500/30" style={{ height: `${inputH}px` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex justify-between mt-2 text-[10px] text-zinc-600 pl-12">
                    <span>{days[0]?.date || ''}</span>
                    {days.length > 10 && <span>{days[Math.floor(days.length / 2)]?.date || ''}</span>}
                    <span>{days[days.length - 1]?.date || ''}</span>
                  </div>
                </div>
              );
            })()}

            {/* Tab: Por Modelo */}
            {activeTab === 'model' && stats.byModel.length > 0 && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                <h3 className="text-sm font-medium text-zinc-300 px-4 py-3 border-b border-zinc-800">
                  Por modelo
                </h3>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-zinc-500 border-b border-zinc-800/50">
                      <th className="text-left px-4 py-2 font-medium">Modelo</th>
                      <th className="text-right px-4 py-2 font-medium">Requests</th>
                      <th className="text-right px-4 py-2 font-medium">Input</th>
                      <th className="text-right px-4 py-2 font-medium">Output</th>
                      <th className="text-right px-4 py-2 font-medium">Custo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.byModel.map((row) => (
                      <tr key={row.model} className="border-b border-zinc-800/30 text-zinc-300">
                        <td className="px-4 py-2 font-mono">{row.model}</td>
                        <td className="text-right px-4 py-2">{row.requests}</td>
                        <td className="text-right px-4 py-2">{formatTokens(row.inputTokens)}</td>
                        <td className="text-right px-4 py-2">{formatTokens(row.outputTokens)}</td>
                        <td className="text-right px-4 py-2 text-amber-400">{formatCost(row.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Tab: Por Agente */}
            {activeTab === 'agent' && agentStats && agentStats.byAgent.length > 0 && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                <h3 className="text-sm font-medium text-zinc-300 px-4 py-3 border-b border-zinc-800">
                  Por agente
                </h3>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-zinc-500 border-b border-zinc-800/50">
                      <th className="text-left px-4 py-2 font-medium">Agente</th>
                      <th className="text-left px-4 py-2 font-medium">Modelo</th>
                      <th className="text-right px-4 py-2 font-medium">Requests</th>
                      <th className="text-right px-4 py-2 font-medium">Input</th>
                      <th className="text-right px-4 py-2 font-medium">Output</th>
                      <th className="text-right px-4 py-2 font-medium">Cache</th>
                      <th className="text-right px-4 py-2 font-medium">Custo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentStats.byAgent.map((row) => (
                      <tr key={`${row.agentId}-${row.model}`} className="border-b border-zinc-800/30 text-zinc-300">
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-amber-500" />
                            {row.agentName}
                          </div>
                        </td>
                        <td className="px-4 py-2 font-mono text-zinc-400">{row.model}</td>
                        <td className="text-right px-4 py-2">{row.totalRequests}</td>
                        <td className="text-right px-4 py-2">{formatTokens(row.inputTokens)}</td>
                        <td className="text-right px-4 py-2">{formatTokens(row.outputTokens)}</td>
                        <td className="text-right px-4 py-2 text-zinc-400">
                          {formatTokens(row.cacheReadTokens + row.cacheCreationTokens)}
                        </td>
                        <td className="text-right px-4 py-2 text-amber-400">{formatCost(row.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Empty state for agent tab */}
            {activeTab === 'agent' && (!agentStats || agentStats.byAgent.length === 0) && stats.totalRequests > 0 && (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <p className="text-sm text-zinc-500">
                  Nenhuma execucao de subagente registrada neste periodo.
                </p>
                <p className="text-xs text-zinc-600 mt-1">
                  Tokens do agente principal aparecem na aba Por Modelo.
                </p>
              </div>
            )}

            {/* Empty state */}
            {stats.totalRequests === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <BarChart3 size={40} className="text-zinc-700 mb-3" />
                <p className="text-sm text-zinc-500">Nenhum uso registrado neste periodo</p>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function MetricCard({ icon, label, value, sub }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
      <div className="flex items-center gap-1.5 text-zinc-500 mb-1">
        {icon}
        <span className="text-[11px]">{label}</span>
      </div>
      <div className="text-xl font-semibold text-zinc-100 font-mono">{value}</div>
      <div className="text-[10px] text-zinc-600 mt-0.5">{sub}</div>
    </div>
  );
}
