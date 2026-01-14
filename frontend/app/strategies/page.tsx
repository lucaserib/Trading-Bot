'use client';

import { useState, useEffect } from 'react';
import { fetchStrategies, createStrategy, updateStrategy, deleteStrategy } from '@/lib/api';

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
  isDryRun: true,
  isTestnet: false,
  apiKey: '',
  apiSecret: '',
  defaultQuantity: 0.002,
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
      isDryRun: strategy.isDryRun,
      isTestnet: strategy.isTestnet,
      apiKey: '',
      apiSecret: '',
      defaultQuantity: strategy.defaultQuantity || 0.002,
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
      isDryRun: formData.isDryRun,
      isTestnet: formData.isTestnet,
      isActive: true,
      defaultQuantity: Number(formData.defaultQuantity),
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
                          s.isDryRun
                            ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                            : s.isTestnet
                            ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                            : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        }`}
                      >
                        {s.isDryRun ? 'DRY RUN' : s.isTestnet ? 'TESTNET' : 'LIVE'}
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

              <div className="space-y-1">
                <label className="text-sm font-medium text-slate-300">Default Qty</label>
                <input
                  type="number"
                  step="0.001"
                  name="defaultQuantity"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-white focus:border-blue-500 outline-none transition"
                  value={formData.defaultQuantity}
                  onChange={handleChange}
                />
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
                    name="isDryRun"
                    className="w-4 h-4 accent-yellow-500"
                    checked={formData.isDryRun}
                    onChange={handleChange}
                  />
                  <span className="text-sm text-slate-300">Dry Run Mode (Simulate Only)</span>
                </label>
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

              <div className="grid grid-cols-3 gap-4 mb-4">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-emerald-400">Take Profit 1 (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    name="takeProfit1"
                    className="w-full bg-slate-900 border border-emerald-500/30 rounded-lg p-3 text-white focus:border-emerald-500 outline-none transition"
                    value={formData.takeProfit1}
                    onChange={handleChange}
                  />
                  <p className="text-xs text-slate-500">Closes 33%</p>
                </div>

                <div className="space-y-1">
                  <label className="text-sm font-medium text-emerald-400">Take Profit 2 (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    name="takeProfit2"
                    className="w-full bg-slate-900 border border-emerald-500/30 rounded-lg p-3 text-white focus:border-emerald-500 outline-none transition"
                    value={formData.takeProfit2}
                    onChange={handleChange}
                  />
                  <p className="text-xs text-slate-500">Closes 50%</p>
                </div>

                <div className="space-y-1">
                  <label className="text-sm font-medium text-emerald-400">Take Profit 3 (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    name="takeProfit3"
                    className="w-full bg-slate-900 border border-emerald-500/30 rounded-lg p-3 text-white focus:border-emerald-500 outline-none transition"
                    value={formData.takeProfit3}
                    onChange={handleChange}
                  />
                  <p className="text-xs text-slate-500">Closes 100%</p>
                </div>
              </div>

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
