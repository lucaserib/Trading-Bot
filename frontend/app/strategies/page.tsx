'use client';

import { useState, useEffect } from 'react';
import { fetchStrategies, createStrategy, updateStrategy, deleteStrategy, pauseStrategy, resumeStrategy, resetSingleMode } from '@/lib/api';

const DEFAULT_FORM_DATA = {
  name: 'New Strategy',
  asset: 'BTCUSDT',
  exchange: 'binance',
  direction: 'LONG',
  leverage: 10,
  marginMode: 'ISOLATED',
  stopLoss: 2,
  takeProfit1: 1,
  takeProfit2: 2,
  takeProfit3: 3,
  moveSLToBreakeven: true,
  isTestnet: false,
  isRealAccount: false,
  apiKey: '',
  apiSecret: '',
  defaultQuantity: 0.002,
  nextCandleEntry: false,
  nextCandlePercentage: 0.2,
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

export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState(DEFAULT_FORM_DATA);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadStrategies();
  }, []);

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
      asset: strategy.asset,
      exchange: strategy.exchange || 'binance',
      direction: strategy.direction,
      leverage: strategy.leverage,
      marginMode: strategy.marginMode,
      stopLoss: strategy.stopLossPercentage || 2,
      takeProfit1: strategy.takeProfitPercentage1 || 1,
      takeProfit2: strategy.takeProfitPercentage2 || 2,
      takeProfit3: strategy.takeProfitPercentage3 || 3,
      moveSLToBreakeven: strategy.moveSLToBreakeven ?? true,
      isTestnet: strategy.isTestnet,
      isRealAccount: strategy.isRealAccount || false,
      apiKey: '',
      apiSecret: '',
      defaultQuantity: strategy.defaultQuantity || 0.002,
      nextCandleEntry: strategy.nextCandleEntry || false,
      nextCandlePercentage: strategy.nextCandlePercentage || 0.2,
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
    if (!confirm('Are you sure you want to delete this strategy?')) return;
    try {
      await deleteStrategy(id);
      loadStrategies();
    } catch (err) {
      console.error(err);
      alert('Failed to delete strategy');
    }
  }

  function handleCancel() {
    setEditingId(null);
    setFormData(DEFAULT_FORM_DATA);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSaving(true);

    const payload: any = {
      name: formData.name,
      asset: formData.asset,
      exchange: formData.exchange,
      direction: formData.direction,
      leverage: Number(formData.leverage),
      marginMode: formData.marginMode,
      stopLossPercentage: Number(formData.stopLoss),
      takeProfitPercentage1: Number(formData.takeProfit1) || null,
      takeProfitPercentage2: Number(formData.takeProfit2) || null,
      takeProfitPercentage3: Number(formData.takeProfit3) || null,
      moveSLToBreakeven: formData.moveSLToBreakeven,
      isTestnet: formData.isTestnet,
      isRealAccount: formData.isRealAccount,
      isActive: true,
      defaultQuantity: Number(formData.defaultQuantity),
      nextCandleEntry: formData.nextCandleEntry,
      nextCandlePercentage: formData.nextCandleEntry ? Number(formData.nextCandlePercentage) : null,
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
      alert(editingId ? 'Strategy Updated!' : 'Strategy Created!');
    } catch (err) {
      console.error(err);
      alert('Failed to save strategy');
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
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api'}/strategies/${strategy.id}/webhook-json?orderType=limit`);
      const data = await response.json();

      let jsonToCopy: any;
      let message: string;

      if (strategy.direction === 'BOTH') {
        if (action) {
          jsonToCopy = data.jsonTemplates[action];
          message = `Webhook JSON for ${action.toUpperCase()} copied!`;
        } else {
          jsonToCopy = data.jsonTemplates.unified;
          message = 'Unified Webhook JSON copied! (works for both BUY and SELL)';
        }
      } else if (strategy.direction === 'LONG') {
        jsonToCopy = data.jsonTemplates.buy;
        message = 'Webhook JSON for BUY copied!';
      } else {
        jsonToCopy = data.jsonTemplates.sell;
        message = 'Webhook JSON for SELL copied!';
      }

      const formattedJson = JSON.stringify(jsonToCopy, null, 2)
        .replace('"{{close}}"', '{{close}}')
        .replace('"{{strategy.order.action}}"', '{{strategy.order.action}}');

      navigator.clipboard.writeText(formattedJson);
      alert(message);
    } catch (error) {
      const fallbackPayload = {
        secret: 'default_secret_123',
        strategyId: strategy.id,
        symbol: strategy.asset,
        action: action || '{{strategy.order.action}}',
        orderType: 'limit',
        price: '{{close}}',
      };
      navigator.clipboard.writeText(JSON.stringify(fallbackPayload, null, 2));
      alert('Webhook JSON copied (using fallback)!');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-3xl font-bold text-white">Strategy Management</h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Strategy List */}
        <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-6 h-fit">
          <h3 className="text-xl font-semibold mb-4 text-white">Active Strategies</h3>
          {loading ? (
            <div className="flex items-center justify-center p-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
          ) : strategies.length === 0 ? (
            <p className="text-slate-400 text-center p-8">No strategies created yet</p>
          ) : (
            <div className="space-y-4">
              {strategies.map((s) => (
                <div
                  key={s.id}
                  className="bg-slate-900/50 rounded-lg border border-slate-700 p-4 hover:border-slate-600 transition-all"
                >
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <h4 className="text-white font-bold text-lg">{s.name}</h4>
                      <div className="flex items-center gap-2">
                         <span className="text-slate-400 font-mono text-sm">{s.asset}</span>
                         <span className="text-slate-500 text-xs px-1.5 py-0.5 bg-slate-800 rounded uppercase">{s.exchange || 'binance'}</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span
                        className={`px-2 py-1 rounded text-xs font-bold ${
                          s.isTestnet
                            ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                            : s.isRealAccount
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : 'bg-slate-500/20 text-slate-400 border border-slate-500/30'
                        }`}
                      >
                        {s.isTestnet ? 'TESTNET' : s.isRealAccount ? '🚨 REAL ACCOUNT' : 'MAINNET'}
                      </span>
                      <span className="text-xs text-slate-500">{s.direction}</span>
                    </div>
                  </div>

                  {/* Risk Settings */}
                  <div className="grid grid-cols-4 gap-2 mb-3 text-xs">
                    <div className="bg-slate-800 rounded p-2">
                      <div className="text-slate-500">Stop Loss</div>
                      <div className="text-rose-400 font-semibold">
                        {s.stopLossPercentage || '-'}%
                      </div>
                    </div>
                    <div className="bg-slate-800 rounded p-2">
                      <div className="text-slate-500">TP1</div>
                      <div className="text-emerald-400 font-semibold">
                        {s.takeProfitPercentage1 || '-'}%
                      </div>
                    </div>
                    <div className="bg-slate-800 rounded p-2">
                      <div className="text-slate-500">TP2</div>
                      <div className="text-emerald-400 font-semibold">
                        {s.takeProfitPercentage2 || '-'}%
                      </div>
                    </div>
                    <div className="bg-slate-800 rounded p-2">
                      <div className="text-slate-500">TP3</div>
                      <div className="text-emerald-400 font-semibold">
                        {s.takeProfitPercentage3 || '-'}%
                      </div>
                    </div>
                  </div>

                  {/* Trading Mode Badges */}
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${s.tradingMode === 'SINGLE' ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
                      {s.tradingMode === 'SINGLE' ? 'Single' : 'Cycle'}
                    </span>
                    {s.enableCompound === false && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-400">
                        No Compound
                      </span>
                    )}
                    {s.allowAveraging && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">
                        Averaging
                      </span>
                    )}
                    {s.hedgeMode && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400">
                        Hedge
                      </span>
                    )}
                    {s.pauseNewOrders && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 animate-pulse">
                        Paused
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => handleEdit(s)}
                      className="text-xs bg-slate-700 hover:bg-blue-600 px-3 py-1.5 rounded text-white transition"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(s.id)}
                      className="text-xs bg-slate-700 hover:bg-rose-600 px-3 py-1.5 rounded text-white transition"
                    >
                      Delete
                    </button>
                    {s.pauseNewOrders ? (
                      <button
                        onClick={async () => {
                          await resumeStrategy(s.id);
                          loadStrategies();
                        }}
                        className="text-xs bg-emerald-700/50 hover:bg-emerald-600 px-3 py-1.5 rounded text-emerald-300 transition"
                      >
                        Resume
                      </button>
                    ) : (
                      <button
                        onClick={async () => {
                          await pauseStrategy(s.id);
                          loadStrategies();
                        }}
                        className="text-xs bg-amber-700/50 hover:bg-amber-600 px-3 py-1.5 rounded text-amber-300 transition"
                      >
                        Pause
                      </button>
                    )}
                    {s.tradingMode === 'SINGLE' && (
                      <button
                        onClick={async () => {
                          await resetSingleMode(s.id);
                          loadStrategies();
                        }}
                        className="text-xs bg-purple-700/50 hover:bg-purple-600 px-3 py-1.5 rounded text-purple-300 transition"
                      >
                        Reset Single
                      </button>
                    )}
                    {s.direction === 'BOTH' ? (
                      <button
                        onClick={() => copyWebhookJson(s)}
                        className="text-xs bg-blue-700/50 hover:bg-blue-600 px-3 py-1.5 rounded text-blue-300 transition"
                      >
                        Copy Unified JSON
                      </button>
                    ) : s.direction === 'LONG' ? (
                      <button
                        onClick={() => copyWebhookJson(s, 'buy')}
                        className="text-xs bg-emerald-700/50 hover:bg-emerald-600 px-3 py-1.5 rounded text-emerald-300 transition"
                      >
                        Copy BUY JSON
                      </button>
                    ) : (
                      <button
                        onClick={() => copyWebhookJson(s, 'sell')}
                        className="text-xs bg-rose-700/50 hover:bg-rose-600 px-3 py-1.5 rounded text-rose-300 transition"
                      >
                        Copy SELL JSON
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Strategy Editor Form */}
        <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-6">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-semibold text-white">
              {editingId ? `Editing: ${formData.name}` : 'Create New Strategy'}
            </h3>
            {editingId && (
              <button onClick={handleCancel} className="text-sm text-slate-400 hover:text-white">
                Cancel
              </button>
            )}
          </div>

          <form className="space-y-4" onSubmit={handleSubmit}>
            {/* Basic Info */}
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-300">Strategy Name</label>
              <input
                name="name"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition"
                value={formData.name}
                onChange={handleChange}
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-300">Asset</label>
                <input
                  name="asset"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-white focus:border-blue-500 outline-none transition"
                  value={formData.asset}
                  onChange={handleChange}
                />
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-300">Exchange</label>
                <select
                  name="exchange"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-white focus:border-blue-500 outline-none transition"
                  value={formData.exchange}
                  onChange={handleChange}
                >
                  <option value="binance">Binance</option>
                  <option value="bybit">Bybit</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-300">Direction</label>
                <select
                  name="direction"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-white focus:border-blue-500 outline-none transition"
                  value={formData.direction}
                  onChange={handleChange}
                >
                  <option value="LONG">LONG</option>
                  <option value="SHORT">SHORT</option>
                  <option value="BOTH">BOTH</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-300">Leverage</label>
                <input
                  type="number"
                  name="leverage"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-white focus:border-blue-500 outline-none transition"
                  value={formData.leverage}
                  onChange={handleChange}
                />
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-300">Margin</label>
                <select
                  name="marginMode"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-white focus:border-blue-500 outline-none transition"
                  value={formData.marginMode}
                  onChange={handleChange}
                >
                  <option value="ISOLATED">ISOLATED</option>
                  <option value="CROSS">CROSS</option>
                </select>
              </div>

            </div>

            {/* Entry & Sizing Settings */}
            <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-700 space-y-4">
              <h4 className="text-white font-medium">Entry & Sizing</h4>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Entry Setting */}
                <div className="space-y-3">
                   <label className="text-sm font-medium text-slate-300">Entry Mode</label>
                   <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
                      <button
                        type="button"
                        onClick={() => setFormData(prev => ({ ...prev, nextCandleEntry: false }))}
                        className={`flex-1 py-1.5 text-xs font-medium rounded ${!formData.nextCandleEntry ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                      >
                        Market
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormData(prev => ({ ...prev, nextCandleEntry: true }))}
                        className={`flex-1 py-1.5 text-xs font-medium rounded ${formData.nextCandleEntry ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                      >
                        Next Candle (Limit)
                      </button>
                   </div>
                   
                   {formData.nextCandleEntry && (
                     <div className="space-y-1 animate-in fade-in slide-in-from-top-2 duration-200">
                        <label className="text-xs text-blue-400">Entry Offset (%)</label>
                        <input
                          type="number"
                          step="0.01"
                          name="nextCandlePercentage"
                          placeholder="0.2"
                          className="w-full bg-slate-800 border border-blue-500/50 rounded p-2 text-white text-sm focus:border-blue-500 outline-none"
                          value={formData.nextCandlePercentage}
                          onChange={handleChange}
                        />
                        <p className="text-[10px] text-slate-500">
                          Long: Price - Offset | Short: Price + Offset
                        </p>
                     </div>
                   )}
                </div>

                {/* Sizing Setting */}
                <div className="space-y-3">
                   <label className="text-sm font-medium text-slate-300">Position Sizing</label>
                   <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
                      <button
                        type="button"
                        onClick={() => setFormData(prev => ({ ...prev, useAccountPercentage: false }))}
                        className={`flex-1 py-1.5 text-xs font-medium rounded ${!formData.useAccountPercentage ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                      >
                        Fixed Qty
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormData(prev => ({ ...prev, useAccountPercentage: true }))}
                        className={`flex-1 py-1.5 text-xs font-medium rounded ${formData.useAccountPercentage ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                      >
                        % of Balance
                      </button>
                   </div>
                   
                   {!formData.useAccountPercentage ? (
                     <div className="space-y-1 animate-in fade-in slide-in-from-top-2 duration-200">
                        <label className="text-xs text-slate-400">Fixed Quantity (Coins)</label>
                        <input
                          type="number"
                          step="0.001"
                          name="defaultQuantity"
                          placeholder="0.002"
                          className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-white text-sm focus:border-slate-500 outline-none"
                          value={formData.defaultQuantity}
                          onChange={handleChange}
                        />
                     </div>
                   ) : (
                      <div className="space-y-1 animate-in fade-in slide-in-from-top-2 duration-200">
                        <label className="text-xs text-blue-400">Percentage of Account (%)</label>
                        <input
                          type="number"
                          step="1"
                          name="accountPercentage"
                          placeholder="10"
                          className="w-full bg-slate-800 border border-blue-500/50 rounded p-2 text-white text-sm focus:border-blue-500 outline-none"
                          value={formData.accountPercentage}
                          onChange={handleChange}
                        />
                        <p className="text-[10px] text-slate-500">
                          Calculated from Available Balance (USDT)
                        </p>
                     </div>
                   )}
                </div>
              </div>
            </div>

            <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-700 space-y-4">
              <h4 className="text-white font-medium">Trading Mode & Advanced</h4>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <label className="text-sm font-medium text-slate-300">Trading Mode</label>
                  <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
                    <button
                      type="button"
                      onClick={() => setFormData(prev => ({ ...prev, tradingMode: 'CYCLE' }))}
                      className={`flex-1 py-1.5 text-xs font-medium rounded ${formData.tradingMode === 'CYCLE' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                    >
                      Cycle
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormData(prev => ({ ...prev, tradingMode: 'SINGLE' }))}
                      className={`flex-1 py-1.5 text-xs font-medium rounded ${formData.tradingMode === 'SINGLE' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                    >
                      Single
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-500">
                    Cycle: Continues trading | Single: Stops after one completed trade
                  </p>
                </div>

                <div className="space-y-3">
                  <label className="text-sm font-medium text-slate-300">Compound</label>
                  <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
                    <button
                      type="button"
                      onClick={() => setFormData(prev => ({ ...prev, enableCompound: true }))}
                      className={`flex-1 py-1.5 text-xs font-medium rounded ${formData.enableCompound ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                    >
                      On
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormData(prev => ({ ...prev, enableCompound: false }))}
                      className={`flex-1 py-1.5 text-xs font-medium rounded ${!formData.enableCompound ? 'bg-slate-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}
                    >
                      Off
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-500">
                    On: Recalculates qty based on current balance | Off: Uses fixed qty from first trade
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-2 pt-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    name="allowAveraging"
                    className="w-4 h-4 accent-purple-500"
                    checked={formData.allowAveraging}
                    onChange={handleChange}
                  />
                  <span className="text-sm text-slate-300">Allow Averaging (Preco Medio)</span>
                  <span className="text-[10px] text-slate-500">- Multiple entries in same direction</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    name="hedgeMode"
                    className="w-4 h-4 accent-orange-500"
                    checked={formData.hedgeMode}
                    onChange={handleChange}
                  />
                  <span className="text-sm text-slate-300">Hedge Mode</span>
                  <span className="text-[10px] text-slate-500">- Allow LONG + SHORT simultaneously</span>
                </label>
              </div>
            </div>

            <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-700 space-y-4">
              <div className="flex justify-between items-center">
                <h4 className="text-white font-medium">Exchange Keys ({formData.exchange === 'bybit' ? 'Bybit' : 'Binance'})</h4>
                {editingId && (
                  <span className="text-xs text-emerald-400 font-mono">Stored securely</span>
                )}
              </div>
              {editingId && (
                <p className="text-xs text-slate-400">
                  Only fill if you want to UPDATE your keys.
                </p>
              )}

              <div className="grid grid-cols-1 gap-4">
                <input
                  name="apiKey"
                  placeholder={editingId ? 'Update API Key (Optional)' : 'API Key'}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg p-3 text-white focus:border-blue-500 outline-none transition"
                  value={formData.apiKey}
                  onChange={handleChange}
                />
                <input
                  type="password"
                  name="apiSecret"
                  placeholder={editingId ? 'Update API Secret (Optional)' : 'API Secret'}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg p-3 text-white focus:border-blue-500 outline-none transition"
                  value={formData.apiSecret}
                  onChange={handleChange}
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    name="isTestnet"
                    className="w-4 h-4 accent-blue-500"
                    checked={formData.isTestnet}
                    onChange={handleChange}
                  />
                  <span className="text-sm text-slate-300">Use Testnet (Binance/Bybit)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    name="isRealAccount"
                    className="w-4 h-4 accent-emerald-500"
                    checked={formData.isRealAccount}
                    onChange={handleChange}
                    disabled={formData.isTestnet}
                  />
                  <span className={`text-sm ${formData.isRealAccount && !formData.isTestnet ? 'text-emerald-400 font-bold' : 'text-slate-300'}`}>
                    🚨 Enable Real Account Trading
                  </span>
                </label>
                {!formData.isTestnet && !formData.isRealAccount && (
                  <p className="text-xs text-rose-400 ml-6 font-semibold">
                    ⚠️ WARNING: You must enable either Testnet OR Real Account. Orders will be BLOCKED without one of these enabled.
                  </p>
                )}
              </div>
            </div>

            {/* Risk Management */}
            <div className="border-t border-slate-700 pt-4 mt-4">
              <h4 className="text-white font-medium mb-4">Risk Management</h4>

              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-rose-400">Stop Loss (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    name="stopLoss"
                    className="w-full bg-slate-900 border border-rose-500/30 rounded-lg p-3 text-white focus:border-rose-500 outline-none transition"
                    value={formData.stopLoss}
                    onChange={handleChange}
                  />
                  <p className="text-xs text-slate-500">Creates STOP_MARKET order on Binance</p>
                </div>
              </div>

                <div className="space-y-1">
                  <div className="flex justify-between">
                     <label className="text-sm font-medium text-emerald-400">TP 1 (%)</label>
                     <label className="text-sm font-medium text-slate-400">Qty (%)</label>
                  </div>
                  <div className="flex gap-2">
                     <input
                        type="number"
                        step="0.1"
                        name="takeProfit1"
                        className="w-full bg-slate-900 border border-emerald-500/30 rounded-lg p-3 text-white focus:border-emerald-500 outline-none transition"
                        value={formData.takeProfit1}
                        onChange={handleChange}
                     />
                     <input
                        type="number"
                        step="1"
                        name="takeProfitQuantity1"
                        className="w-1/2 bg-slate-900 border border-slate-600 rounded-lg p-3 text-white focus:border-slate-400 outline-none transition text-center"
                        value={formData.takeProfitQuantity1}
                        onChange={handleChange}
                     />
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between">
                     <label className="text-sm font-medium text-emerald-400">TP 2 (%)</label>
                     <label className="text-sm font-medium text-slate-400">Qty (%)</label>
                  </div>
                  <div className="flex gap-2">
                     <input
                        type="number"
                        step="0.1"
                        name="takeProfit2"
                        className="w-full bg-slate-900 border border-emerald-500/30 rounded-lg p-3 text-white focus:border-emerald-500 outline-none transition"
                        value={formData.takeProfit2}
                        onChange={handleChange}
                     />
                     <input
                        type="number"
                        step="1"
                        name="takeProfitQuantity2"
                        className="w-1/2 bg-slate-900 border border-slate-600 rounded-lg p-3 text-white focus:border-slate-400 outline-none transition text-center"
                        value={formData.takeProfitQuantity2}
                        onChange={handleChange}
                     />
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between">
                     <label className="text-sm font-medium text-emerald-400">TP 3 (%)</label>
                     <label className="text-sm font-medium text-slate-400">Qty (%)</label>
                  </div>
                  <div className="flex gap-2">
                     <input
                        type="number"
                        step="0.1"
                        name="takeProfit3"
                        className="w-full bg-slate-900 border border-emerald-500/30 rounded-lg p-3 text-white focus:border-emerald-500 outline-none transition"
                        value={formData.takeProfit3}
                        onChange={handleChange}
                     />
                     <input
                        type="number"
                        step="1"
                        name="takeProfitQuantity3"
                        className="w-1/2 bg-slate-900 border border-slate-600 rounded-lg p-3 text-white focus:border-slate-400 outline-none transition text-center"
                        value={formData.takeProfitQuantity3}
                        onChange={handleChange}
                     />
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                 <label className="flex items-center gap-2 cursor-pointer">
                   <input
                     type="checkbox"
                     name="moveSLToBreakeven"
                     className="w-4 h-4 accent-emerald-500"
                     checked={formData.moveSLToBreakeven}
                     onChange={handleChange}
                   />
                   <span className="text-sm text-slate-300">Move SL to Breakeven after TP2</span>
                 </label>

                 <label className="flex items-center gap-2 cursor-pointer">
                   <input
                     type="checkbox"
                     name="breakAgain"
                     className="w-4 h-4 accent-blue-500"
                     checked={formData.breakAgain}
                     onChange={handleChange}
                   />
                   <span className="text-sm text-slate-300 font-semibold text-blue-400">Enable "Break Again" (Trail SL to last TP)</span>
                 </label>
              </div>


            <button
              type="submit"
              disabled={isSaving}
              className={`w-full font-bold py-3 rounded-lg mt-4 transition transform active:scale-95 text-white ${
                isSaving
                  ? 'bg-slate-600 cursor-not-allowed'
                  : editingId
                  ? 'bg-amber-600 hover:bg-amber-500'
                  : 'bg-blue-600 hover:bg-blue-500'
              }`}
            >
              {isSaving ? 'Saving...' : editingId ? 'Update Configuration' : 'Create Strategy'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
