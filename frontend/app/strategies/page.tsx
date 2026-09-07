'use client';

import { useState, useEffect } from 'react';
import { fetchStrategies, createStrategy, updateStrategy, deleteStrategy, pauseStrategy, resumeStrategy, resetSingleMode, fetchPortfolios, Portfolio } from '@/lib/api';

const DEFAULT_FORM_DATA = {
  name: 'New Strategy',
  portfolioId: '',
  asset: 'BTCUSDT',
  exchange: 'binance',
  direction: 'LONG',
  leverage: 10,
  marginMode: 'ISOLATED',
  stopLoss: 2,
  takeProfit1: 1,
  takeProfit2: 2,
  takeProfit3: 3,
  enableTakeProfit1: true,
  enableTakeProfit2: true,
  enableTakeProfit3: true,
  moveSLToBreakeven: true,
  isTestnet: false,
  isRealAccount: false,
  apiKey: '',
  apiSecret: '',
  defaultQuantity: 0.002,
  bufferEntry: false,
  bufferPercentage: 0.2,
  timeframe: '',
  useAccountPercentage: false,
  accountPercentage: 10,
  takeProfitQuantity1: 33,
  takeProfitQuantity2: 33,
  takeProfitQuantity3: 34,
  breakAgain: false,
  enableCompound: true,
  tradingMode: 'CYCLE',
  allowAveraging: false,
  hedgeMode: false,
};

function formatPortfolioOption(p: Portfolio): string {
  return `${p.name} · ${p.exchange.toUpperCase()} · ${p.mode}`;
}

export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<any[]>([]);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState(DEFAULT_FORM_DATA);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => { loadStrategies(); loadPortfolios(); }, []);

  async function loadPortfolios() {
    try {
      const data = await fetchPortfolios();
      setPortfolios(data);
    } catch (error) {
      console.error(error);
    }
  }

  async function loadStrategies() {
    try {
      const data = await fetchStrategies();
      setStrategies(data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  function handleEdit(strategy: any) {
    setEditingId(strategy.id);
    setFormData({
      name: strategy.name,
      portfolioId: strategy.portfolioId || '',
      asset: strategy.asset,
      exchange: strategy.exchange || 'binance',
      direction: strategy.direction,
      leverage: strategy.leverage,
      marginMode: strategy.marginMode,
      stopLoss: strategy.stopLossPercentage || 2,
      takeProfit1: strategy.takeProfitPercentage1 || 1,
      takeProfit2: strategy.takeProfitPercentage2 || 2,
      takeProfit3: strategy.takeProfitPercentage3 || 3,
      enableTakeProfit1: strategy.enableTakeProfit1 ?? true,
      enableTakeProfit2: strategy.enableTakeProfit2 ?? true,
      enableTakeProfit3: strategy.enableTakeProfit3 ?? true,
      moveSLToBreakeven: strategy.moveSLToBreakeven ?? true,
      isTestnet: strategy.isTestnet,
      isRealAccount: strategy.isRealAccount || false,
      apiKey: '',
      apiSecret: '',
      defaultQuantity: strategy.defaultQuantity || 0.002,
      bufferEntry: strategy.bufferEntry || false,
      bufferPercentage: strategy.bufferPercentage || 0.2,
      timeframe: strategy.timeframe || '',
      useAccountPercentage: strategy.useAccountPercentage || false,
      accountPercentage: strategy.accountPercentage || 10,
      takeProfitQuantity1: strategy.takeProfitQuantity1 || 33,
      takeProfitQuantity2: strategy.takeProfitQuantity2 || 33,
      takeProfitQuantity3: strategy.takeProfitQuantity3 || 34,
      breakAgain: strategy.breakAgain || false,
      enableCompound: strategy.enableCompound ?? true,
      tradingMode: strategy.tradingMode || 'CYCLE',
      allowAveraging: strategy.allowAveraging || false,
      hedgeMode: strategy.hedgeMode || false,
    });
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  async function handleDelete(id: string) {
    if (!confirm('Tem certeza que deseja deletar esta estratégia?')) return;
    try {
      await deleteStrategy(id);
      loadStrategies();
    } catch (err) {
      console.error(err);
      alert('Falha ao deletar estratégia');
    }
  }

  function handleCancel() {
    setEditingId(null);
    setFormData(DEFAULT_FORM_DATA);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!editingId && portfolios.length > 0 && !formData.portfolioId) {
      alert('Selecione um portfólio para a nova estratégia.');
      return;
    }

    setIsSaving(true);

    const payload: any = {
      name: formData.name,
      portfolioId: formData.portfolioId || null,
      asset: formData.asset,
      exchange: formData.exchange,
      direction: formData.direction,
      leverage: Number(formData.leverage),
      marginMode: formData.marginMode,
      stopLossPercentage: Number(formData.stopLoss),
      takeProfitPercentage1: formData.enableTakeProfit1 ? (Number(formData.takeProfit1) || null) : null,
      takeProfitPercentage2: formData.enableTakeProfit2 ? (Number(formData.takeProfit2) || null) : null,
      takeProfitPercentage3: formData.enableTakeProfit3 ? (Number(formData.takeProfit3) || null) : null,
      enableTakeProfit1: formData.enableTakeProfit1,
      enableTakeProfit2: formData.enableTakeProfit2,
      enableTakeProfit3: formData.enableTakeProfit3,
      moveSLToBreakeven: formData.moveSLToBreakeven,
      isTestnet: formData.isTestnet,
      isRealAccount: formData.isRealAccount,
      isActive: true,
      defaultQuantity: Number(formData.defaultQuantity),
      bufferEntry: formData.bufferEntry,
      bufferPercentage: formData.bufferEntry ? Number(formData.bufferPercentage) : null,
      timeframe: formData.bufferEntry && formData.timeframe ? formData.timeframe : null,
      useAccountPercentage: formData.useAccountPercentage,
      accountPercentage: formData.useAccountPercentage ? Number(formData.accountPercentage) : null,
      takeProfitQuantity1: Number(formData.takeProfitQuantity1),
      takeProfitQuantity2: Number(formData.takeProfitQuantity2),
      takeProfitQuantity3: Number(formData.takeProfitQuantity3),
      breakAgain: formData.breakAgain,
      enableCompound: formData.enableCompound,
      tradingMode: formData.tradingMode,
      allowAveraging: formData.allowAveraging,
      hedgeMode: formData.hedgeMode,
    };

    if (formData.apiKey) payload.apiKey = formData.apiKey;
    if (formData.apiSecret) payload.apiSecret = formData.apiSecret;

    try {
      if (editingId) {
        await updateStrategy(editingId, payload);
      } else {
        await createStrategy(payload);
      }
      loadStrategies();
      handleCancel();
      alert(editingId ? 'Estratégia atualizada!' : 'Estratégia criada!');
    } catch (err) {
      console.error(err);
      alert('Falha ao salvar estratégia');
    } finally {
      setIsSaving(false);
    }
  }

  const handleChange = (e: any) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const copyWebhookJson = async (strategy: any, action?: 'buy' | 'sell') => {
    const orderType = strategy.bufferEntry ? 'limit' : 'market';
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api'}/strategies/${strategy.id}/webhook-json?orderType=${orderType}`);
      const data = await response.json();

      let jsonToCopy: any;
      let message: string;

      if (strategy.direction === 'BOTH') {
        if (action) {
          jsonToCopy = data.jsonTemplates[action];
          message = `Webhook JSON para ${action.toUpperCase()} copiado!`;
        } else {
          jsonToCopy = data.jsonTemplates.unified;
          message = 'Webhook JSON unificado copiado!';
        }
      } else if (strategy.direction === 'LONG') {
        jsonToCopy = data.jsonTemplates.buy;
        message = 'Webhook JSON para BUY copiado!';
      } else {
        jsonToCopy = data.jsonTemplates.sell;
        message = 'Webhook JSON para SELL copiado!';
      }

      const formattedJson = JSON.stringify(jsonToCopy, null, 2)
        .replace('"{{close}}"', '{{close}}')
        .replace('"{{strategy.order.action}}"', '{{strategy.order.action}}');

      navigator.clipboard.writeText(formattedJson);
      alert(message);
    } catch (error) {
      const fallbackPayload: any = {
        secret: 'default_secret_123',
        strategyId: strategy.id,
        symbol: strategy.asset,
        action: action || '{{strategy.order.action}}',
        price: '{{close}}',
      };
      if (orderType === 'limit') {
        fallbackPayload.orderType = 'limit';
      }
      navigator.clipboard.writeText(JSON.stringify(fallbackPayload, null, 2));
      alert('Webhook JSON copiado (fallback)!');
    }
  };

  const inputClass = 'w-full bg-secondary/80 border border-border/60 rounded-md px-3 py-2.5 text-sm text-foreground focus:border-primary/50 focus:ring-1 focus:ring-primary/30 outline-none transition placeholder:text-muted-foreground/50';
  const selectClass = inputClass;
  const labelClass = 'text-xs font-medium text-muted-foreground';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">Estratégias</h1>
        <p className="text-xs text-muted-foreground mt-0.5">Gerencie suas estratégias de trading</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <div className="glass-card rounded-lg">
          <div className="px-4 py-3 border-b border-border/40">
            <h3 className="text-sm font-semibold text-foreground">Estratégias Ativas</h3>
          </div>
          <div className="p-4">
            {loading ? (
              <div className="flex items-center justify-center p-8">
                <span className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              </div>
            ) : strategies.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center p-8">Nenhuma estratégia criada</p>
            ) : (
              <div className="space-y-3">
                {strategies.map((s) => (
                  <div
                    key={s.id}
                    className="bg-secondary/40 rounded-lg border border-border/40 p-4 hover:border-border/80 transition-all"
                  >
                    <div className="flex justify-between items-start mb-2.5">
                      <div>
                        <div className="flex items-center gap-1.5">
                          <h4 className="text-foreground font-bold text-sm">{s.name}</h4>
                          {s.portfolio && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-primary/10 text-primary border border-primary/20">
                              {s.portfolio.name}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-muted-foreground font-mono text-xs">{s.asset}</span>
                          <span className="text-[10px] px-1.5 py-0.5 bg-secondary rounded text-muted-foreground uppercase">{s.portfolio?.exchange || s.exchange || 'binance'}</span>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                          s.isTestnet
                            ? 'bg-blue-500/15 text-blue-400 border-blue-500/30'
                            : s.isRealAccount
                            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                            : 'bg-secondary text-muted-foreground border-border/40'
                        }`}>
                          {s.isTestnet ? 'TESTNET' : s.isRealAccount ? 'REAL' : 'MAINNET'}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{s.direction}</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-4 gap-1.5 mb-2.5 text-[10px]">
                      <div className="bg-secondary/80 rounded px-2 py-1.5">
                        <div className="text-muted-foreground/60">SL</div>
                        <div className="text-red-400 font-semibold font-mono">{s.stopLossPercentage || '-'}%</div>
                      </div>
                      <div className="bg-secondary/80 rounded px-2 py-1.5">
                        <div className="text-muted-foreground/60">TP1</div>
                        <div className="text-emerald-400 font-semibold font-mono">{s.takeProfitPercentage1 || '-'}%</div>
                      </div>
                      <div className="bg-secondary/80 rounded px-2 py-1.5">
                        <div className="text-muted-foreground/60">TP2</div>
                        <div className="text-emerald-400 font-semibold font-mono">{s.takeProfitPercentage2 || '-'}%</div>
                      </div>
                      <div className="bg-secondary/80 rounded px-2 py-1.5">
                        <div className="text-muted-foreground/60">TP3</div>
                        <div className="text-emerald-400 font-semibold font-mono">{s.takeProfitPercentage3 || '-'}%</div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1 mb-2.5">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium border ${s.tradingMode === 'SINGLE' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' : 'bg-blue-500/10 text-blue-400 border-blue-500/20'}`}>
                        {s.tradingMode === 'SINGLE' ? 'Single' : 'Cycle'}
                      </span>
                      {s.enableCompound === false && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-secondary text-muted-foreground border border-border/40">
                          No Compound
                        </span>
                      )}
                      {s.allowAveraging && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">
                          Averaging
                        </span>
                      )}
                      {s.hedgeMode && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-orange-500/10 text-orange-400 border border-orange-500/20">
                          Hedge
                        </span>
                      )}
                      {s.pauseNewOrders && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded font-medium bg-red-500/10 text-red-400 border border-red-500/20 pulse-dot">
                          Pausada
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      <Btn onClick={() => handleEdit(s)} variant="default">Editar</Btn>
                      <Btn onClick={() => handleDelete(s.id)} variant="danger">Deletar</Btn>
                      {s.pauseNewOrders ? (
                        <Btn onClick={async () => { await resumeStrategy(s.id); loadStrategies(); }} variant="success">Retomar</Btn>
                      ) : (
                        <Btn onClick={async () => { await pauseStrategy(s.id); loadStrategies(); }} variant="warning">Pausar</Btn>
                      )}
                      {s.tradingMode === 'SINGLE' && (
                        <Btn onClick={async () => { await resetSingleMode(s.id); loadStrategies(); }} variant="purple">Reset Single</Btn>
                      )}
                      {s.direction === 'BOTH' ? (
                        <Btn onClick={() => copyWebhookJson(s)} variant="primary">Copy JSON</Btn>
                      ) : s.direction === 'LONG' ? (
                        <Btn onClick={() => copyWebhookJson(s, 'buy')} variant="success">Copy BUY</Btn>
                      ) : (
                        <Btn onClick={() => copyWebhookJson(s, 'sell')} variant="danger">Copy SELL</Btn>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="glass-card rounded-lg">
          <div className="px-4 py-3 border-b border-border/40 flex justify-between items-center">
            <h3 className="text-sm font-semibold text-foreground">
              {editingId ? `Editando: ${formData.name}` : 'Nova Estratégia'}
            </h3>
            {editingId && (
              <button onClick={handleCancel} className="text-xs text-muted-foreground hover:text-foreground transition">
                Cancelar
              </button>
            )}
          </div>

          <form className="p-4 space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-1">
              <label className={labelClass}>Nome da Estratégia</label>
              <input name="name" className={inputClass} value={formData.name} onChange={handleChange} />
            </div>

            <div className="space-y-1">
              <label className={labelClass}>Portfólio</label>
              <select name="portfolioId" className={selectClass} value={formData.portfolioId} onChange={handleChange}>
                <option value="">Selecione um portfólio</option>
                {portfolios.map((p) => (
                  <option key={p.id} value={p.id}>{formatPortfolioOption(p)}</option>
                ))}
              </select>
              {!editingId && portfolios.length === 0 && (
                <p className="text-[9px] text-muted-foreground/60">Nenhum portfólio cadastrado — cadastre um em Portfólios ou preencha as chaves manualmente abaixo.</p>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className={labelClass}>Ativo</label>
                <input name="asset" className={inputClass} value={formData.asset} onChange={handleChange} />
              </div>
              {!formData.portfolioId && (
                <div className="space-y-1">
                  <label className={labelClass}>Exchange</label>
                  <select name="exchange" className={selectClass} value={formData.exchange} onChange={handleChange}>
                    <option value="binance">Binance</option>
                    <option value="bybit">Bybit</option>
                  </select>
                </div>
              )}
              <div className="space-y-1">
                <label className={labelClass}>Direção</label>
                <select name="direction" className={selectClass} value={formData.direction} onChange={handleChange}>
                  <option value="LONG">LONG</option>
                  <option value="SHORT">SHORT</option>
                  <option value="BOTH">BOTH</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className={labelClass}>Alavancagem</label>
                <input type="number" name="leverage" className={inputClass} value={formData.leverage} onChange={handleChange} />
              </div>
              <div className="space-y-1">
                <label className={labelClass}>Margem</label>
                <select name="marginMode" className={selectClass} value={formData.marginMode} onChange={handleChange}>
                  <option value="ISOLATED">ISOLADA</option>
                  <option value="CROSS">CRUZADA</option>
                </select>
              </div>
            </div>

            <Section title="Entrada & Sizing">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className={labelClass}>Modo de Entrada</label>
                  <ToggleGroup
                    options={[{ label: 'Market', value: false }, { label: 'Buffer (Limit)', value: true }]}
                    value={formData.bufferEntry}
                    onChange={(v) => setFormData(prev => ({ ...prev, bufferEntry: v as boolean }))}
                  />
                  {formData.bufferEntry && (
                    <div className="space-y-1">
                      <label className="text-[10px] text-accent">Entry Offset (%)</label>
                      <input type="number" step="0.01" name="bufferPercentage" className={inputClass} value={formData.bufferPercentage} onChange={handleChange} />
                      <p className="text-[9px] text-muted-foreground/60">Long: Price - Offset | Short: Price + Offset</p>
                      <label className="text-[10px] text-accent">Timeframe do gráfico</label>
                      <select name="timeframe" className={selectClass} value={formData.timeframe} onChange={handleChange}>
                        <option value="">Sem timeframe (expira em 5 min)</option>
                        <option value="1m">1m</option>
                        <option value="3m">3m</option>
                        <option value="5m">5m</option>
                        <option value="15m">15m</option>
                        <option value="30m">30m</option>
                        <option value="1h">1h</option>
                        <option value="2h">2h</option>
                        <option value="4h">4h</option>
                        <option value="1d">1d</option>
                      </select>
                      <p className="text-[9px] text-muted-foreground/60">Sem timeframe, a ordem expira em 5 minutos.</p>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <label className={labelClass}>Position Sizing</label>
                  <ToggleGroup
                    options={[{ label: 'Qty Fixa', value: false }, { label: '% Banca', value: true }]}
                    value={formData.useAccountPercentage}
                    onChange={(v) => setFormData(prev => ({ ...prev, useAccountPercentage: v as boolean }))}
                  />
                  {!formData.useAccountPercentage ? (
                    <div className="space-y-1">
                      <label className="text-[10px] text-muted-foreground">Quantidade Fixa (Coins)</label>
                      <input type="number" step="0.001" name="defaultQuantity" className={inputClass} value={formData.defaultQuantity} onChange={handleChange} />
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <label className="text-[10px] text-accent">Percentual da Conta (%)</label>
                      <input type="number" step="1" name="accountPercentage" className={inputClass} value={formData.accountPercentage} onChange={handleChange} />
                      <p className="text-[9px] text-muted-foreground/60">Calculado do saldo disponível (USDT)</p>
                    </div>
                  )}
                </div>
              </div>
            </Section>

            <Section title="Trading Mode & Avançado">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className={labelClass}>Modo de Trading</label>
                  <ToggleGroup
                    options={[{ label: 'Cycle', value: 'CYCLE' }, { label: 'Single', value: 'SINGLE' }]}
                    value={formData.tradingMode}
                    onChange={(v) => setFormData(prev => ({ ...prev, tradingMode: v as string }))}
                  />
                  <p className="text-[9px] text-muted-foreground/60">Cycle: Continua | Single: Para após 1 trade</p>
                </div>

                <div className="space-y-2">
                  <label className={labelClass}>Compound</label>
                  <ToggleGroup
                    options={[{ label: 'On', value: true }, { label: 'Off', value: false }]}
                    value={formData.enableCompound}
                    onChange={(v) => setFormData(prev => ({ ...prev, enableCompound: v as boolean }))}
                  />
                  <p className="text-[9px] text-muted-foreground/60">On: Recalcula qty | Off: Qty fixa do 1o trade</p>
                </div>
              </div>

              <div className="flex flex-col gap-2 pt-2">
                <Checkbox name="allowAveraging" checked={formData.allowAveraging} onChange={handleChange} label="Allow Averaging (Preço Médio)" sub="Múltiplas entradas na mesma direção" color="accent-purple-500" />
                <Checkbox name="hedgeMode" checked={formData.hedgeMode} onChange={handleChange} label="Hedge Mode" sub="Permitir LONG + SHORT simultaneamente" color="accent-orange-500" />
              </div>
            </Section>

            {!formData.portfolioId && (
              <Section title={`Exchange Keys (${formData.exchange === 'bybit' ? 'Bybit' : 'Binance'})`}>
                {editingId && (
                  <p className="text-[10px] text-muted-foreground mb-2">Preencha apenas se quiser ATUALIZAR as chaves.</p>
                )}
                <div className="space-y-2">
                  <input name="apiKey" placeholder={editingId ? 'Update API Key (Opcional)' : 'API Key'} className={inputClass} value={formData.apiKey} onChange={handleChange} />
                  <input type="password" name="apiSecret" placeholder={editingId ? 'Update API Secret (Opcional)' : 'API Secret'} className={inputClass} value={formData.apiSecret} onChange={handleChange} />
                </div>
                <div className="flex flex-col gap-2 mt-3">
                  <Checkbox name="isTestnet" checked={formData.isTestnet} onChange={handleChange} label="Usar Testnet" color="accent-blue-500" />
                  <Checkbox name="isRealAccount" checked={formData.isRealAccount} onChange={handleChange} disabled={formData.isTestnet} label="Habilitar Conta Real" color="accent-emerald-500" />
                  {!formData.isTestnet && !formData.isRealAccount && (
                    <p className="text-[10px] text-red-400 ml-6 font-semibold">
                      Ative Testnet OU Conta Real. Ordens serão BLOQUEADAS sem uma dessas opções.
                    </p>
                  )}
                </div>
              </Section>
            )}

            <Section title="Gerenciamento de Risco">
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-red-400">Stop Loss (%)</label>
                  <input type="number" step="0.1" name="stopLoss" className={`${inputClass} !border-red-500/20 focus:!border-red-500/50`} value={formData.stopLoss} onChange={handleChange} />
                </div>
              </div>

              {[
                { idx: 1, tp: 'takeProfit1', tpQty: 'takeProfitQuantity1', enable: 'enableTakeProfit1' },
                { idx: 2, tp: 'takeProfit2', tpQty: 'takeProfitQuantity2', enable: 'enableTakeProfit2' },
                { idx: 3, tp: 'takeProfit3', tpQty: 'takeProfitQuantity3', enable: 'enableTakeProfit3' },
              ].map(({ idx, tp, tpQty, enable }) => {
                const enabled = (formData as any)[enable];
                return (
                  <div key={idx} className="space-y-1 mb-2">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-2">
                        <input type="checkbox" name={enable} className="w-3.5 h-3.5 accent-emerald-500 rounded" checked={enabled} onChange={handleChange} />
                        <label className="text-xs font-medium text-emerald-400">TP {idx} (%)</label>
                      </div>
                      <label className="text-xs font-medium text-muted-foreground">Qty (%)</label>
                    </div>
                    <div className="flex gap-2">
                      <input type="number" step="0.1" name={tp} disabled={!enabled} className={`${inputClass} ${!enabled ? 'opacity-40 cursor-not-allowed' : '!border-emerald-500/20'}`} value={(formData as any)[tp]} onChange={handleChange} />
                      <input type="number" step="1" name={tpQty} disabled={!enabled} className={`w-1/2 ${inputClass} text-center ${!enabled ? 'opacity-40 cursor-not-allowed' : ''}`} value={(formData as any)[tpQty]} onChange={handleChange} />
                    </div>
                  </div>
                );
              })}

              <div className="flex flex-col gap-2 pt-2">
                <Checkbox name="moveSLToBreakeven" checked={formData.moveSLToBreakeven} onChange={handleChange} label="Move SL para Breakeven após TP2" color="accent-emerald-500" />
                <Checkbox name="breakAgain" checked={formData.breakAgain} onChange={handleChange} label="Break Again (Trail SL para último TP)" color="accent-blue-500" />
              </div>
            </Section>

            <button
              type="submit"
              disabled={isSaving}
              className={`w-full font-semibold py-2.5 rounded-lg text-sm transition-all ${
                isSaving
                  ? 'bg-secondary text-muted-foreground cursor-not-allowed'
                  : editingId
                  ? 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/30 hover:bg-yellow-500/25'
                  : 'bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 glow-primary'
              }`}
            >
              {isSaving ? 'Salvando...' : editingId ? 'Atualizar Configuração' : 'Criar Estratégia'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-secondary/30 p-4 rounded-lg border border-border/30 space-y-3">
      <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider">{title}</h4>
      {children}
    </div>
  );
}

function ToggleGroup({ options, value, onChange }: { options: { label: string; value: any }[]; value: any; onChange: (v: any) => void }) {
  return (
    <div className="flex bg-secondary rounded-md p-0.5 border border-border/40">
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`flex-1 py-1.5 text-[11px] font-medium rounded-sm transition-all ${
            value === opt.value
              ? 'bg-primary/20 text-primary shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Checkbox({ name, checked, onChange, label, sub, disabled, color = 'accent-primary' }: {
  name: string; checked: boolean; onChange: (e: any) => void; label: string; sub?: string; disabled?: boolean; color?: string;
}) {
  return (
    <label className={`flex items-center gap-2 cursor-pointer ${disabled ? 'opacity-40' : ''}`}>
      <input type="checkbox" name={name} className={`w-3.5 h-3.5 ${color} rounded`} checked={checked} onChange={onChange} disabled={disabled} />
      <span className="text-xs text-foreground">{label}</span>
      {sub && <span className="text-[9px] text-muted-foreground/60">{sub}</span>}
    </label>
  );
}

function Btn({ onClick, variant, children }: { onClick: () => void; variant: string; children: React.ReactNode }) {
  const styles: Record<string, string> = {
    default: 'bg-secondary hover:bg-primary/20 text-foreground hover:text-primary border-border/40',
    danger: 'bg-red-500/10 hover:bg-red-500/20 text-red-400 border-red-500/20',
    success: 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border-emerald-500/20',
    warning: 'bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 border-yellow-500/20',
    primary: 'bg-primary/10 hover:bg-primary/20 text-primary border-primary/20',
    purple: 'bg-purple-500/10 hover:bg-purple-500/20 text-purple-400 border-purple-500/20',
  };
  return (
    <button
      onClick={onClick}
      className={`text-[10px] px-2.5 py-1.5 rounded-md font-medium border transition-all ${styles[variant] || styles.default}`}
    >
      {children}
    </button>
  );
}
