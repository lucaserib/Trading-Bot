'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  fetchPortfolios,
  createPortfolio,
  updatePortfolio,
  deletePortfolio,
  testPortfolioConnection,
  Portfolio,
  PortfolioExchange,
  PortfolioMode,
} from '@/lib/api';

const EXCHANGE_OPTIONS: Array<{ value: PortfolioExchange; label: string; disabled?: boolean }> = [
  { value: 'bybit', label: 'Bybit' },
  { value: 'binance', label: 'Binance' },
  { value: 'okx', label: 'OKX El Salvador (em breve)', disabled: true },
  { value: 'bingx', label: 'BingX (em breve)', disabled: true },
];

const DEFAULT_FORM = {
  name: '',
  exchange: 'bybit' as PortfolioExchange,
  mode: 'DEMO' as PortfolioMode,
  apiKey: '',
  apiSecret: '',
};

export default function PortfoliosPage() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState(DEFAULT_FORM);
  const [isSaving, setIsSaving] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; balance?: number; message?: string }>>({});
  const [testingId, setTestingId] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const data = await fetchPortfolios();
      setPortfolios(data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  function openCreateModal() {
    setEditingId(null);
    setFormData(DEFAULT_FORM);
    setModalOpen(true);
  }

  function openEditModal(portfolio: Portfolio) {
    setEditingId(portfolio.id);
    setFormData({
      name: portfolio.name,
      exchange: portfolio.exchange,
      mode: portfolio.mode,
      apiKey: '',
      apiSecret: '',
    });
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
    setFormData(DEFAULT_FORM);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSaving(true);
    const payload: Record<string, unknown> = {
      name: formData.name,
      exchange: formData.exchange,
      mode: formData.mode,
    };
    if (formData.apiKey) payload.apiKey = formData.apiKey;
    if (formData.apiSecret) payload.apiSecret = formData.apiSecret;

    try {
      if (editingId) {
        await updatePortfolio(editingId, payload);
      } else {
        await createPortfolio(payload);
      }
      await load();
      closeModal();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Erro desconhecido';
      alert(`Falha ao salvar portfólio: ${msg}`);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Tem certeza que deseja excluir este portfólio?')) return;
    try {
      await deletePortfolio(id);
      await load();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Erro desconhecido';
      alert(msg);
    }
  }

  async function handleTestConnection(id: string) {
    setTestingId(id);
    try {
      const result = await testPortfolioConnection(id);
      setTestResults((prev) => ({ ...prev, [id]: result }));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Erro desconhecido';
      setTestResults((prev) => ({ ...prev, [id]: { success: false, message: msg } }));
    } finally {
      setTestingId(null);
    }
  }

  const inputClass = 'w-full bg-secondary/80 border border-border/60 rounded-md px-3 py-2.5 text-sm text-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/30 outline-none transition placeholder:text-muted-foreground/50';
  const labelClass = 'text-xs font-medium text-muted-foreground';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Portfólios"
        subtitle={`${portfolios.length} portfólio(s) cadastrado(s)`}
        rightSlot={
          <button
            onClick={openCreateModal}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-all"
          >
            + Novo Portfólio
          </button>
        }
      />

      {loading ? (
        <div className="flex items-center justify-center p-12">
          <span className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : portfolios.length === 0 ? (
        <div className="glass-card rounded-lg p-8 text-center text-sm text-muted-foreground">
          Nenhum portfólio cadastrado ainda.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {portfolios.map((p) => {
            const result = testResults[p.id];
            return (
              <div key={p.id} className="glass-card rounded-lg p-4 space-y-3">
                <div className="flex justify-between items-start">
                  <div>
                    <h4 className="text-foreground font-bold text-sm">{p.name}</h4>
                    <span className="text-[10px] px-1.5 py-0.5 bg-secondary rounded text-muted-foreground uppercase mt-1 inline-block">
                      {p.exchange}
                    </span>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                    p.mode === 'DEMO'
                      ? 'bg-violet-500/15 text-violet-400 border-violet-500/30'
                      : 'bg-red-500/15 text-red-400 border-red-500/30'
                  }`}>
                    {p.mode}
                  </span>
                </div>

                <div className="text-xs text-muted-foreground font-mono">
                  API Key: {p.apiKeyMasked || '—'}
                </div>

                <div className="flex items-center gap-1.5 text-xs">
                  <span className={`w-1.5 h-1.5 rounded-full ${p.isActive ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
                  <span className="text-muted-foreground">Status: {p.isActive ? 'ativo' : 'inativo'}</span>
                </div>

                {result && (
                  <div className={`text-[11px] rounded-md px-2 py-1.5 border ${
                    result.success
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                      : 'bg-red-500/10 text-red-400 border-red-500/20'
                  }`}>
                    {result.success ? `Saldo: ${result.balance?.toFixed(2) ?? '0.00'} USDT` : result.message}
                  </div>
                )}

                <div className="flex flex-wrap gap-1.5 pt-1">
                  <button
                    onClick={() => handleTestConnection(p.id)}
                    disabled={testingId === p.id}
                    className="text-[10px] px-2.5 py-1.5 rounded-md font-medium border bg-secondary hover:bg-primary/20 text-foreground hover:text-primary border-border/40 transition-all disabled:opacity-50"
                  >
                    {testingId === p.id ? 'Testando...' : 'Testar conexão'}
                  </button>
                  <button
                    onClick={() => openEditModal(p)}
                    className="text-[10px] px-2.5 py-1.5 rounded-md font-medium border bg-secondary hover:bg-primary/20 text-foreground hover:text-primary border-border/40 transition-all"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => handleDelete(p.id)}
                    className="text-[10px] px-2.5 py-1.5 rounded-md font-medium border bg-red-500/10 hover:bg-red-500/20 text-red-400 border-red-500/20 transition-all"
                  >
                    Excluir
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={closeModal}>
          <div className="glass-card rounded-lg w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-border/40">
              <h3 className="text-sm font-semibold text-foreground">
                {editingId ? 'Editar Portfólio' : 'Novo Portfólio'}
              </h3>
            </div>
            <form className="p-4 space-y-3" onSubmit={handleSubmit}>
              <div className="space-y-1">
                <label className={labelClass}>Nome do Portfólio</label>
                <input
                  className={inputClass}
                  placeholder="ex.: Subconta Scalping"
                  value={formData.name}
                  onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                  required
                />
              </div>

              <div className="space-y-1">
                <label className={labelClass}>Corretora</label>
                <select
                  className={inputClass}
                  value={formData.exchange}
                  onChange={(e) => setFormData((prev) => ({ ...prev, exchange: e.target.value as PortfolioExchange }))}
                >
                  {EXCHANGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className={labelClass}>Modo</label>
                <div className="flex bg-secondary rounded-md p-0.5 border border-border/40">
                  {(['DEMO', 'REAL'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setFormData((prev) => ({ ...prev, mode }))}
                      className={`flex-1 py-1.5 text-[11px] font-medium rounded-sm transition-all ${
                        formData.mode === mode
                          ? 'bg-primary/20 text-primary shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {mode === 'DEMO' ? 'Demo' : 'Real'}
                    </button>
                  ))}
                </div>
              </div>

              {editingId && (
                <p className="text-[10px] text-muted-foreground">Preencha apenas se quiser ATUALIZAR as chaves.</p>
              )}
              <div className="space-y-1">
                <label className={labelClass}>API Key</label>
                <input
                  className={inputClass}
                  placeholder={editingId ? 'Atualizar API Key (opcional)' : 'API Key'}
                  value={formData.apiKey}
                  onChange={(e) => setFormData((prev) => ({ ...prev, apiKey: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <label className={labelClass}>Secret Key</label>
                <input
                  type="password"
                  className={inputClass}
                  placeholder={editingId ? 'Atualizar Secret Key (opcional)' : 'Secret Key'}
                  value={formData.apiSecret}
                  onChange={(e) => setFormData((prev) => ({ ...prev, apiSecret: e.target.value }))}
                />
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="flex-1 py-2 rounded-lg text-sm font-medium bg-secondary text-muted-foreground hover:text-foreground transition-all"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex-1 py-2 rounded-lg text-sm font-semibold bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-all disabled:opacity-50"
                >
                  {isSaving ? 'Salvando...' : editingId ? 'Atualizar' : 'Criar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
