// Runs before the first paint, so a saved dark choice never flashes light.
try { if (localStorage.getItem('rg-theme') === 'dark') document.documentElement.dataset.theme = 'dark'; } catch { /* storage blocked: the light default stands */ }
