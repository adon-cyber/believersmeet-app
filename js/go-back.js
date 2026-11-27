window.goBack = function () {
    const fallbackPage = 'feed.html';
    let cameFromBelieversMeet = false;

    try {
        if (document.referrer) {
            cameFromBelieversMeet =
                new URL(document.referrer).origin === window.location.origin;
        }
    } catch (error) {
        cameFromBelieversMeet = false;
    }

    if (cameFromBelieversMeet && window.history.length > 1) {
        window.history.back();
    } else {
        window.location.href = fallbackPage;
    }
};
