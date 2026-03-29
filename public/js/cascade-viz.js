// HAOL Demo — Cascade animation engine

const CascadeViz = {
  _layers: ["deterministic", "semantic", "escalation", "fallback"],

  reset() {
    for (const name of this._layers) {
      const card = document.querySelector(`.layer-card[data-layer="${name}"]`);
      if (!card) continue;
      card.dataset.state = "idle";
      card.querySelector(".layer-status-icon").textContent = "";
      card.querySelector(".meta-latency").textContent = "";
      card.querySelector(".meta-confidence").textContent = "";
      card.querySelector(".layer-reason").textContent = "";
    }
    const totalEl = document.getElementById("total-latency");
    if (totalEl) totalEl.style.display = "none";
  },

  async animate(trace) {
    if (!trace || !trace.layers) return;

    this.reset();
    await this._sleep(200);

    for (const attempt of trace.layers) {
      const card = document.querySelector(`.layer-card[data-layer="${attempt.layer}"]`);
      if (!card) continue;

      // Phase 1: Attempting
      card.dataset.state = "attempting";
      card.querySelector(".layer-status-icon").textContent = "";

      // Hold for actual latency (min 200ms for active layers, 100ms for skipped)
      const isSkipped = attempt.status === "skipped";
      const holdMs = isSkipped ? 100 : Math.max(attempt.latency_ms, 200);
      await this._sleep(holdMs);

      // Phase 2: Resolve
      card.dataset.state = attempt.status;
      card.querySelector(".layer-status-icon").textContent = this._statusIcon(attempt.status);

      // Show metadata
      if (attempt.latency_ms != null && !isSkipped) {
        card.querySelector(".meta-latency").textContent =
          attempt.latency_ms < 1
            ? `${attempt.latency_ms.toFixed(2)}ms`
            : `${Math.round(attempt.latency_ms)}ms`;
      }

      if (attempt.confidence != null) {
        card.querySelector(".meta-confidence").textContent =
          `confidence: ${(attempt.confidence * 100).toFixed(1)}%`;
      }
      if (attempt.similarity_score != null) {
        const existing = card.querySelector(".meta-confidence").textContent;
        const sim = `similarity: ${(attempt.similarity_score * 100).toFixed(1)}%`;
        card.querySelector(".meta-confidence").textContent = existing
          ? `${existing}  |  ${sim}`
          : sim;
      }

      if (attempt.reason) {
        card.querySelector(".layer-reason").textContent = attempt.reason;
      }

      // Pause between active layers for readability
      if (!isSkipped) {
        await this._sleep(300);
      }
    }

    // Show total latency
    if (trace.total_latency_ms != null) {
      const totalEl = document.getElementById("total-latency");
      const valEl = document.getElementById("total-latency-value");
      if (totalEl && valEl) {
        valEl.textContent = `${Math.round(trace.total_latency_ms)}ms`;
        totalEl.style.display = "block";
      }
    }
  },

  _statusIcon(status) {
    switch (status) {
      case "matched":
        return "\u2713";
      case "missed":
        return "\u2717";
      case "skipped":
        return "\u2014";
      case "error":
        return "!";
      default:
        return "";
    }
  },

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};
