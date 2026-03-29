// HAOL Demo — API client

const API = {
  async submitTask(prompt) {
    const res = await fetch("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async getSavings(hours = 24) {
    const res = await fetch(`/observability/stats/savings?hours=${hours}`);
    if (!res.ok) return null;
    return res.json();
  },
};
