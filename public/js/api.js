// HAOL Demo — API client
// Uses /demo/api/* endpoints which bypass auth, scoped to demo use only.

const API = {
  async submitTask(prompt) {
    const res = await fetch("/demo/api/task", {
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

  async getSavings(since) {
    const param = since ? `since=${encodeURIComponent(since)}` : "hours=24";
    const res = await fetch(`/demo/api/savings?${param}`);
    if (!res.ok) return null;
    return res.json();
  },
};
