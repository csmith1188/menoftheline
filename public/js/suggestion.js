const overlay = document.getElementById("suggest-modal");
const openBtn = document.getElementById("suggest-open");
const cancelBtn = document.getElementById("suggest-cancel");
const bugCheck = document.getElementById("suggest-bug");
const reproWrap = document.getElementById("suggest-repro-wrap");
const reproField = document.getElementById("suggest-repro");

if (overlay && openBtn) {
  function hide() {
    overlay.classList.add("hidden");
  }

  function show() {
    overlay.classList.remove("hidden");
    const body = document.getElementById("suggest-body");
    if (body) body.focus();
  }

  function syncRepro() {
    const on = Boolean(bugCheck && bugCheck.checked);
    if (reproWrap) reproWrap.classList.toggle("hidden", !on);
    if (reproField) {
      reproField.required = on;
      if (!on) reproField.value = "";
    }
  }

  openBtn.addEventListener("click", show);
  if (cancelBtn) cancelBtn.addEventListener("click", hide);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) hide();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.classList.contains("hidden")) hide();
  });
  if (bugCheck) {
    bugCheck.addEventListener("change", syncRepro);
    syncRepro();
  }
}
