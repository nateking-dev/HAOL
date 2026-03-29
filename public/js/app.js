// HAOL Demo — Main application

(function () {
  // State
  let running = false;
  let totalCost = 0;

  // DOM references
  const promptInput = document.getElementById("prompt-input");
  const submitBtn = document.getElementById("submit-btn");
  const demoPromptsEl = document.getElementById("demo-prompts");
  const costTicker = document.getElementById("cost-ticker");
  const costActual = document.getElementById("cost-actual");
  const costCounterfactual = document.getElementById("cost-counterfactual");
  const savingsRow = document.getElementById("savings-row");
  const savingsValue = document.getElementById("savings-value");
  const selectionEmpty = document.getElementById("selection-empty");
  const selectionDetail = document.getElementById("selection-detail");
  const winnerAgent = document.getElementById("winner-agent");
  const winnerTier = document.getElementById("winner-tier");
  const scoringBody = document.getElementById("scoring-body");
  const policyWeights = document.getElementById("policy-weights");
  const responseEmpty = document.getElementById("response-empty");
  const responseContent = document.getElementById("response-content");

  // Render demo prompt cards
  DEMO_PROMPTS.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "demo-prompt-card";
    const label = document.createElement("div");
    label.className = "prompt-label";
    label.textContent = p.label;
    card.appendChild(label);
    card.appendChild(document.createTextNode(p.display || p.prompt));
    card.addEventListener("click", () => {
      if (running) return;
      promptInput.value = p.prompt;
      promptInput.focus();
      document.querySelectorAll(".demo-prompt-card").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
    });
    demoPromptsEl.appendChild(card);
  });

  // Submit button
  submitBtn.addEventListener("click", () => {
    const prompt = promptInput.value.trim();
    if (!prompt || running) return;
    document.querySelectorAll(".demo-prompt-card").forEach((c) => c.classList.remove("active"));
    runTask(prompt);
  });

  // Enter key to submit
  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitBtn.click();
    }
  });

  async function runTask(prompt) {
    running = true;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span>Routing...';

    // Reset UI
    CascadeViz.reset();
    resetResultPanel();

    try {
      const result = await API.submitTask(prompt);

      // Animate cascade
      if (result.cascade_trace) {
        await CascadeViz.animate(result.cascade_trace);
      }

      // Show agent selection
      renderSelection(result);

      // Show response
      renderResponse(result);

      // Update cost
      updateCost(result.cost_usd);
    } catch (err) {
      responseEmpty.style.display = "none";
      responseContent.style.display = "block";
      responseContent.textContent = `Error: ${err.message}`;
      responseContent.style.color = "var(--red-400)";
    } finally {
      running = false;
      submitBtn.disabled = false;
      submitBtn.innerHTML = "Route Task";
    }
  }

  function resetResultPanel() {
    selectionEmpty.style.display = "block";
    selectionDetail.style.display = "none";
    responseEmpty.style.display = "block";
    responseContent.style.display = "none";
    responseContent.style.color = "";
    scoringBody.innerHTML = "";
    policyWeights.textContent = "";
  }

  function renderSelection(result) {
    if (!result.selected_agent_id) return;

    selectionEmpty.style.display = "none";
    selectionDetail.style.display = "block";

    winnerAgent.textContent = result.selected_agent_id;
    winnerTier.textContent = result.complexity_tier ? `T${result.complexity_tier}` : "";

    if (result.selection_detail) {
      const { scored_candidates, policy_weights, fallback_applied } = result.selection_detail;

      // Render scoring table
      scoringBody.innerHTML = "";
      for (const c of scored_candidates) {
        const isWinner = c.agent_id === result.selected_agent_id;
        const tr = document.createElement("tr");
        if (isWinner) tr.className = "winner";
        const cells = [
          c.agent_id,
          c.capability_score.toFixed(2),
          c.cost_score.toFixed(2),
          c.latency_score.toFixed(2),
          c.total_score.toFixed(3),
        ];
        cells.forEach((text) => {
          const td = document.createElement("td");
          td.textContent = text;
          tr.appendChild(td);
        });
        scoringBody.appendChild(tr);
      }

      // Show policy weights
      if (policy_weights) {
        policyWeights.textContent = `Weights: capability \u00d7 ${policy_weights.capability} + cost \u00d7 ${policy_weights.cost} + latency \u00d7 ${policy_weights.latency}`;
      }

      if (fallback_applied && fallback_applied !== "NONE") {
        policyWeights.textContent += ` | Fallback: ${fallback_applied}`;
      }
    }
  }

  function renderResponse(result) {
    responseEmpty.style.display = "none";
    responseContent.style.display = "block";

    if (result.status === "FAILED") {
      responseContent.textContent = `Task failed: ${result.error || "Unknown error"}`;
      responseContent.style.color = "var(--red-400)";
      return;
    }

    const content = result.response_content || "(no response content)";
    // Truncate for display
    if (content.length > 2000) {
      responseContent.textContent = content.slice(0, 2000) + "\n\n... [truncated]";
    } else {
      responseContent.textContent = content;
    }
  }

  function updateCost(costUsd) {
    if (costUsd == null) return;

    totalCost += costUsd;
    costTicker.style.display = "block";
    costActual.textContent = `$${totalCost.toFixed(4)}`;

    // Fetch savings for the counterfactual
    API.getSavings(1).then((savings) => {
      if (!savings || savings.task_count === 0) return;

      costCounterfactual.textContent = `$${savings.counterfactual_cost.toFixed(4)}`;
      if (savings.savings_pct > 0) {
        savingsRow.style.display = "flex";
        savingsValue.textContent = `${savings.savings_pct.toFixed(1)}%`;
      }
    });
  }
})();
