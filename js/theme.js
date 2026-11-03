Select-String -Path .\join-church.html -Pattern 'adonstance@gmail.com','is_super_admin','const isSuperAdmin','let isSuperAdmin' -Context 2,4// Standardized light theme initialization (dark/light toggle removed completely)
(function initTheme() {
    document.documentElement.classList.remove('dark');
    localStorage.removeItem('theme');
})();
