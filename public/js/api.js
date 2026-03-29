// HAOL Demo — API client

const API = {
  async submitTask(prompt) {
    const res = await fetch("/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // The server returns the full TaskResult on 500 (FAILED tasks),
      // which still contains cascade_trace and selection_detail for the demo.
      if (data && data.cascade_trace) {
        return data;
      }
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return data;
  },

  async getSavings(hours = 24) {
    const res = await fetch(`/observability/stats/savings?hours=${hours}`);
    if (!res.ok) return null;
    return res.json();
  },
};
