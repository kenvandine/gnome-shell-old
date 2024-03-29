/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Signals = imports.signals;
const Tweener = imports.tweener.tweener;

// This is a wrapper around imports.tweener.tweener that adds a bit of
// Clutter integration and some additional callbacks:
//
//   1. If the tweening target is a Clutter.Actor, then the tweenings
//      will automatically be removed if the actor is destroyed
//
//   2. If target._delegate.onAnimationStart() exists, it will be
//      called when the target starts being animated.
//
//   3. If target._delegate.onAnimationComplete() exists, it will be
//      called once the target is no longer being animated.
//
// The onAnimationStart() and onAnimationComplete() callbacks differ
// from the tweener onStart and onComplete parameters, in that (1)
// they track whether or not the target has *any* tweens attached to
// it, as opposed to be called for *each* tween, and (2)
// onAnimationComplete() is always called when the object stops being
// animated, regardless of whether it stopped normally or abnormally.
//
// onAnimationComplete() is called at idle time, which means that if a
// tween completes and then another is added before returning to the
// main loop, the complete callback will not be called (until the new
// tween finishes).


// ActionScript Tweener methods that imports.tweener.tweener doesn't
// currently implement: getTweens, getVersion, registerTransition,
// setTimeScale, updateTime.

// imports.tweener.tweener methods that we don't re-export:
// pauseAllTweens, removeAllTweens, resumeAllTweens. (It would be hard
// to clean up properly after removeAllTweens, and also, any code that
// calls any of these is almost certainly wrong anyway, because they
// affect the entire application.)


// Called from Main.start
function init() {
    Tweener.setFrameTicker(new ClutterFrameTicker());
}


function addCaller(target, tweeningParameters) {
    _wrapTweening(target, tweeningParameters);
    Tweener.addCaller(target, tweeningParameters);
}

function addTween(target, tweeningParameters) {
    _wrapTweening(target, tweeningParameters);
    Tweener.addTween(target, tweeningParameters);
}

function _wrapTweening(target, tweeningParameters) {
    let state = _getTweenState(target);

    if (target instanceof Clutter.Actor && !state.destroyedId)
        state.destroyedId = target.connect('destroy', _actorDestroyed);
    
    _addHandler(target, tweeningParameters, 'onStart', _tweenStarted);
    _addHandler(target, tweeningParameters, 'onComplete', _tweenCompleted);
}

function _getTweenState(target) {
    // If we were paranoid, we could keep a plist mapping targets to
    // states... but we're not that paranoid.
    if (!target.__ShellTweenerState)
        _resetTweenState(target);
    return target.__ShellTweenerState;
}

function _resetTweenState(target) {
    let state = target.__ShellTweenerState;

    if (state) {
        if (state.destroyedId)
            target.disconnect(state.destroyedId);
        if (state.idleCompletedId)
            Mainloop.source_remove(state.idleCompletedId);
    }

    target.__ShellTweenerState = {};
}

function _addHandler(target, params, name, handler) {
    if (params[name]) {
        let oldHandler = params[name];
        let oldScope = params[name + 'Scope'];
        let oldParams = params[name + 'Params'];
        let eventScope = oldScope ? oldScope : target;

        params[name] = function () {
            oldHandler.apply(eventScope, oldParams);
            handler(target);
        };
    } else
        params[name] = function () { handler(target); };
}

function _actorDestroyed(target) {
    _resetTweenState(target);
    Tweener.removeTweens(target);
}

function _tweenStarted(target) {
    let state = _getTweenState(target);
    let delegate = target._delegate;

    if (!state.running && delegate && delegate.onAnimationStart)
        delegate.onAnimationStart();
    state.running = true;
}

function _tweenCompleted(target) {
    let state = _getTweenState(target);

    if (!state.idleCompletedId)
        state.idleCompletedId = Mainloop.idle_add(Lang.bind(null, _idleCompleted, target));
}

function _idleCompleted(target) {
    let state = _getTweenState(target);
    let delegate = target._delegate;

    if (!isTweening(target)) {
        _resetTweenState(target);
        if (delegate && delegate.onAnimationComplete)
            delegate.onAnimationComplete();
    }
    return false;
}

function getTweenCount(scope) {
    return Tweener.getTweenCount(scope);
}

// imports.tweener.tweener doesn't provide this method (which exists
// in the ActionScript version) but it's easy to implement.
function isTweening(scope) {
    return Tweener.getTweenCount(scope) != 0;
}

function removeTweens(scope) {
    if (Tweener.removeTweens.apply(null, arguments)) {
        // If we just removed the last active tween, clean up
        if (Tweener.getTweenCount(scope) == 0)
            _tweenCompleted(scope);
        return true;
    } else
        return false;
}

function pauseTweens() {
    return Tweener.pauseTweens.apply(null, arguments);
}

function resumeTweens() {
    return Tweener.resumeTweens.apply(null, arguments);
}


function registerSpecialProperty(name, getFunction, setFunction,
                                 parameters, preProcessFunction) {
    Tweener.registerSpecialProperty(name, getFunction, setFunction,
				    parameters, preProcessFunction);
}

function registerSpecialPropertyModifier(name, modifyFunction, getFunction) {
    Tweener.registerSpecialPropertyModifier(name, modifyFunction, getFunction);
}

function registerSpecialPropertySplitter(name, splitFunction, parameters) {
    Tweener.registerSpecialPropertySplitter(name, splitFunction, parameters);
}


// The "FrameTicker" object is an object used to feed new frames to
// Tweener so it can update values and redraw. The default frame
// ticker for Tweener just uses a simple timeout at a fixed frame rate
// and has no idea of "catching up" by dropping frames.
//
// We substitute it with custom frame ticker here that connects
// Tweener to a Clutter.TimeLine. Now, Clutter.Timeline itself isn't a
// whole lot more sophisticated than a simple timeout at a fixed frame
// rate, but at least it knows how to drop frames. (See
// HippoAnimationManager for a more sophisticated view of continous
// time updates; even better is to pay attention to the vertical
// vblank and sync to that when possible.)
//
function ClutterFrameTicker() {
    this._init();
}

ClutterFrameTicker.prototype = {
    FRAME_RATE : 60,

    _init : function() {
        // We don't have a finite duration; tweener will tell us to stop
        // when we need to stop, so use 1000 seconds as "infinity"
        this._timeline = new Clutter.Timeline({ duration: 1000*1000 });
        this._startTime = -1;
        this._currentTime = -1;

        let me = this;
        this._timeline.connect('new-frame',
            function(timeline, frame) {
                me._onNewFrame(frame);
            });
    },

    _onNewFrame : function(frame) {
        // If there is a lot of setup to start the animation, then
        // first frame number we get from clutter might be a long ways
        // into the animation (or the animation might even be done).
        // That looks bad, so we always start at the first frame of the
        // animation then only do frame dropping from there.
        if (this._startTime < 0)
            this._startTime = this._timeline.get_elapsed_time();

        // currentTime is in milliseconds
        this._currentTime = this._timeline.get_elapsed_time() - this._startTime;
        this.emit('prepare-frame');
    },

    getTime : function() {
        return this._currentTime;
    },

    start : function() {
        this._timeline.start();
    },

    stop : function() {
        this._timeline.stop();
        this._startTime = -1;
        this._currentTime = -1;
    }
};

Signals.addSignalMethods(ClutterFrameTicker.prototype);
