// Standardized light theme initialization (dark/light toggle removed completely)
(function initTheme() {
    document.documentElement.classList.remove('dark');
    localStorage.removeItem('theme');
})();
