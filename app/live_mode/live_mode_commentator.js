const DEFAULT_STATUS_PHRASES = [
    'ANALYZING RADAR DATA',
    'SCANNING WEATHER DATA',
    'PROCESSING ALERT DATA',
    'READING FORECAST DATA'
];

class LiveModeCommentator {
    constructor(options) {
        this.isActive = options.isActive;
        this.schedule = options.schedule;
        this.pickRandom = options.pickRandom;
        this.statusPhrases = options.statusPhrases || DEFAULT_STATUS_PHRASES;
        this.dwellAfterTypingMs = options.dwellAfterTypingMs || 4000;

        this.typewriterTimer = null;
        this.commentaryFadeTimer = null;
        this.typewriterFinished = true;
        this.onTypewriterFinished = null;
    }

    stopTypewriter() {
        if (this.typewriterTimer) {
            clearTimeout(this.typewriterTimer);
            this.typewriterTimer = null;
        }
        if (this.commentaryFadeTimer) {
            clearTimeout(this.commentaryFadeTimer);
            this.commentaryFadeTimer = null;
        }
        this.typewriterFinished = true;
        this.onTypewriterFinished = null;
    }

    showCommentaryBox() {
        var $box = $('#lmCommentaryBox');
        $box.removeClass('lmCommentaryBox-fading');
        $box.addClass('lmCommentaryBox-visible');
    }

    hideCommentaryBox() {
        var self = this;
        var $box = $('#lmCommentaryBox');
        if (!$box.hasClass('lmCommentaryBox-visible')) return;
        $box.addClass('lmCommentaryBox-fading');
        this.commentaryFadeTimer = setTimeout(function () {
            $box.removeClass('lmCommentaryBox-visible lmCommentaryBox-fading');
            $('#lmCommentary').text('');
            $('#lmCommentaryStatus').text('');
            self.commentaryFadeTimer = null;
        }, 400);
    }

    typewrite(text, delayMs) {
        this.stopTypewriter();
        this.typewriterFinished = false;
        var $el = $('#lmCommentary');
        var $status = $('#lmCommentaryStatus');
        if (!$el.length || !text) {
            this.typewriterFinished = true;
            return;
        }

        $el.text('').removeClass('lmCommentary-done');
        $status.text(this.pickRandom(this.statusPhrases));
        this.showCommentaryBox();

        var self = this;
        var idx = 0;
        var baseDelay = 22;
        var queue = text.split('');

        function tick() {
            if (!self.isActive() || idx >= queue.length) {
                if (self.typewriterTimer) {
                    clearTimeout(self.typewriterTimer);
                    self.typewriterTimer = null;
                }
                $el.addClass('lmCommentary-done');
                $status.text('');
                self.typewriterFinished = true;
                if (typeof self.onTypewriterFinished === 'function') {
                    var cb = self.onTypewriterFinished;
                    self.onTypewriterFinished = null;
                    cb();
                }
                return;
            }
            if (idx === 0) $status.text('');
            var ch = queue[idx++];
            $el.text($el.text() + ch);

            var next = baseDelay + Math.random() * 12;
            if (ch === '.' || ch === '!' || ch === '?') next += 180;
            else if (ch === ',') next += 80;
            self.typewriterTimer = setTimeout(tick, next);
        }

        this.typewriterTimer = setTimeout(tick, delayMs || 800);
    }

    waitForTypewriterThen(callback) {
        var self = this;
        if (this.typewriterFinished) {
            this.schedule(callback, this.dwellAfterTypingMs);
            return;
        }
        this.onTypewriterFinished = function () {
            self.schedule(callback, self.dwellAfterTypingMs);
        };
    }
}

module.exports = LiveModeCommentator;
