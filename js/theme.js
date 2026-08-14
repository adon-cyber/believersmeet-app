// Apply saved theme immediately before DOM loads to prevent flashing
(function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
})();

// Global function to toggle between Light & Dark Mode
window.toggleTheme = function() {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    
    // Dispatch custom event if other components need to react to theme changes
    window.dispatchEvent(new Event('themeChanged'));
};

// Alias for compatibility
window.toggleDarkMode = window.toggleTheme;

