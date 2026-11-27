/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {
  createFactory,
  PureComponent,
} = require("resource://devtools/client/shared/vendor/react.mjs");
const dom = require("resource://devtools/client/shared/vendor/react-dom-factories.js");
const PropTypes = require("resource://devtools/client/shared/vendor/react-prop-types.mjs");

const AnimationName = createFactory(
  require("resource://devtools/client/inspector/animation/components/graph/AnimationName.js")
);
const DelaySign = createFactory(
  require("resource://devtools/client/inspector/animation/components/graph/DelaySign.js")
);
const EndDelaySign = createFactory(
  require("resource://devtools/client/inspector/animation/components/graph/EndDelaySign.js")
);
const SummaryGraphPath = createFactory(
  require("resource://devtools/client/inspector/animation/components/graph/SummaryGraphPath.js")
);

const {
  getFormattedTitle,
  getStr,
} = require("resource://devtools/client/inspector/animation/utils/l10n.js");

class SummaryGraph extends PureComponent {
  static get propTypes() {
    return {
      animation: PropTypes.object.isRequired,
      getAnimatedPropertyMap: PropTypes.func.isRequired,
      selectAnimation: PropTypes.func.isRequired,
      simulateAnimation: PropTypes.func.isRequired,
      timeScale: PropTypes.object.isRequired,
    };
  }

  constructor(props) {
    super(props);

    this.onClick = this.onClick.bind(this);
  }

  onClick(event) {
    event.stopPropagation();
    this.props.selectAnimation(this.props.animation);
  }

  getTitleText(state) {
    const getTime = time =>
      getStr("animation-inspector-time-seconds", { time: time / 1000 });
    const getTimeOrInfinity = time =>
      time === Infinity
        ? getStr("animation-inspector-infinity")
        : getTime(time);

    // Adding the name.
    const lines = [getFormattedTitle(state)];

    // Adding the delay.
    if (state.delay) {
      lines.push(
        getStr("animation-inspector-tooltip-delay", {
          delay: getTime(state.delay),
        })
      );
    }

    // Adding the duration.
    lines.push(
      getStr("animation-inspector-tooltip-duration", {
        duration: getTimeOrInfinity(state.duration),
      })
    );

    // Adding the endDelay.
    if (state.endDelay) {
      lines.push(
        getStr("animation-inspector-tooltip-end-delay", {
          endDelay: getTime(state.endDelay),
        })
      );
    }

    // Adding the iteration count (the infinite symbol, or an integer).
    if (state.iterationCount !== 1) {
      lines.push(
        getStr("animation-inspector-tooltip-iteration-count", {
          count: state.iterationCount || getStr("animation-inspector-infinity"),
        })
      );
    }

    // Adding the iteration start.
    if (state.iterationStart !== 0) {
      lines.push(
        getStr("animation-inspector-tooltip-iteration-start", {
          iterationStart: state.iterationStart,
          time: getTimeOrInfinity(state.iterationStart * state.duration),
        })
      );
    }

    // Adding the easing if it is not "linear".
    if (state.easing && state.easing !== "linear") {
      lines.push(
        getStr("animation-inspector-tooltip-overall-easing", {
          easing: state.easing,
        })
      );
    }

    // Adding the fill mode.
    if (state.fill && state.fill !== "none") {
      lines.push(
        getStr("animation-inspector-tooltip-fill", { fill: state.fill })
      );
    }

    // Adding the direction mode if it is not "normal".
    if (state.direction && state.direction !== "normal") {
      lines.push(
        getStr("animation-inspector-tooltip-direction", {
          direction: state.direction,
        })
      );
    }

    // Adding the playback rate if it's different than 1.
    if (state.playbackRate !== 1) {
      lines.push(
        getStr("animation-inspector-tooltip-playback-rate", {
          rate: state.playbackRate,
        })
      );
    }

    // Adding the animation-timing-function
    // if it is not "ease" which is default value for CSS Animations.
    if (
      state.animationTimingFunction &&
      state.animationTimingFunction !== "ease"
    ) {
      lines.push(
        getStr("animation-inspector-tooltip-timing-function", {
          timingFunction: state.animationTimingFunction,
        })
      );
    }

    // Adding a note that the animation is running on the compositor thread if
    // needed.
    if (state.propertyState) {
      if (
        state.propertyState.every(propState => propState.runningOnCompositor)
      ) {
        lines.push(getStr("animation-inspector-all-properties-on-compositor"));
      } else if (
        state.propertyState.some(propState => propState.runningOnCompositor)
      ) {
        lines.push(getStr("animation-inspector-some-properties-on-compositor"));
      }
    } else if (state.isRunningOnCompositor) {
      lines.push(getStr("animation-inspector-running-on-compositor"));
    }

    return lines.join("\n");
  }

  render() {
    const { animation, getAnimatedPropertyMap, simulateAnimation, timeScale } =
      this.props;

    const { iterationCount } = animation.state;
    const { delay, endDelay } = animation.state.absoluteValues;

    return dom.div(
      {
        className:
          "animation-summary-graph" +
          (animation.state.isRunningOnCompositor ? " compositor" : ""),
        onClick: this.onClick,
        title: this.getTitleText(animation.state),
      },
      SummaryGraphPath({
        animation,
        getAnimatedPropertyMap,
        simulateAnimation,
        timeScale,
      }),
      delay
        ? DelaySign({
            animation,
            timeScale,
          })
        : null,
      iterationCount && endDelay
        ? EndDelaySign({
            animation,
            timeScale,
          })
        : null,
      animation.state.name
        ? AnimationName({
            animation,
          })
        : null
    );
  }
}

module.exports = SummaryGraph;
