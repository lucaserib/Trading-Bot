const getApiUrl = () => {
  const url = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
  if (url.startsWith('http')) return url;
  return `https://${url}`;
};

const API_URL = getApiUrl();

export async function fetchStrategies() {
  const res = await fetch(`${API_URL}/api/strategies`, {
    cache: 'no-store'
  });
  if (!res.ok) throw new Error('Failed to fetch strategies');
  return res.json();
}

export async function createStrategy(data: any) {
  const res = await fetch(`${API_URL}/api/strategies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to create strategy');
  return res.json();
}

export async function updateStrategy(id: string, data: any) {
  const res = await fetch(`${API_URL}/api/strategies/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update strategy');
  return res.json();
}

export async function deleteStrategy(id: string) {
  const res = await fetch(`${API_URL}/api/strategies/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete strategy');
}
