/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import React, { useEffect, useState } from "react";
import PropTypes from "prop-types/prop-types";
import { Localized, CONFIGURABLE_STYLES } from "./MSLocalized";
import { MultiStageUtils } from "../lib/multistage-utils.mjs";
import {
  SecondaryCTA,
  StepsIndicator,
  ProgressBar,
} from "./MultiStageAboutWelcome";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { CTAParagraph } from "./CTAParagraph";
import { HeroImage } from "./HeroImage";
import { OnboardingVideo } from "./OnboardingVideo";
import { AdditionalCTA } from "./AdditionalCTA";
import { LinkParagraph } from "./LinkParagraph";
import { ContentTiles, CONTAINER_STYLES, HEADER_STYLES } from "./ContentTiles";
import { InstallButton } from "./InstallButton";
import { SubmenuButton } from "./SubmenuButton";

const DEFAULT_AUTO_ADVANCE_MS = 20000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const CORNER_IMAGE_POSITIONS = new Set([
  "bottom-left",
  "bottom-right",
  "top-left",
  "top-right",
]);
const DEFAULT_CORNER_IMAGE_POSITION = "bottom-right";
const CORNER_IMAGE_ENTRANCE_ANIMATIONS = new Set([
  "none",
  "fade",
  "slide-block",
  "slide-inline",
  "slide-corner",
  "zoom",
]);
const DEFAULT_CORNER_IMAGE_ENTRANCE_ANIMATION = "none";
// Direction-relative aliases for the positions above, mapped to [ltr, rtl] so
// that `*-end` follows the reading direction the way inset-inline-end would.
const CORNER_IMAGE_LOGICAL_POSITIONS = new Map([
  ["bottom-start", ["bottom-left", "bottom-right"]],
  ["bottom-end", ["bottom-right", "bottom-left"]],
  ["top-start", ["top-left", "top-right"]],
  ["top-end", ["top-right", "top-left"]],
]);

/**
 * Resolves a corner_image position to one of CORNER_IMAGE_POSITIONS, so the
 * rendered class is always a physical corner. Unsupported values fall back
 * to bottom-right.
 */
function resolveCornerImagePosition(position) {
  const logical = CORNER_IMAGE_LOGICAL_POSITIONS.get(position);
  if (logical) {
    const isRTL =
      typeof document !== "undefined" &&
      document.documentElement.matches(":dir(rtl)");
    return logical[isRTL ? 1 : 0];
  }
  return CORNER_IMAGE_POSITIONS.has(position)
    ? position
    : DEFAULT_CORNER_IMAGE_POSITION;
}

/**
 * Applies an image's `rtl` overrides when the document is right-to-left.
 */
function resolveDirectionalImage(image) {
  const isRTL =
    typeof document !== "undefined" &&
    document.documentElement.matches(":dir(rtl)");
  return isRTL && image?.rtl ? { ...image, ...image.rtl } : image;
}

/**
 * Dismisses the message once the screen has been shown for `autoDismiss.after`
 * milliseconds. The countdown only runs while the page is visible and restarts
 * when it becomes visible again, so the screen can't time out while invisible
 * in the background.
 */
function useAutoDismiss(autoDismiss, messageId) {
  const after = autoDismiss?.after;
  useEffect(() => {
    if (!Number.isFinite(after) || after < 0 || after > MAX_TIMEOUT_MS) {
      return undefined;
    }

    let timer = null;
    let dismissed = false;
    const dismiss = () => {
      dismissed = true;
      MultiStageUtils.sendActionTelemetry(
        messageId,
        "auto_dismiss",
        "AUTO_DISMISS"
      );
      window.AWFinish();
    };
    const restartCountdown = () => {
      clearTimeout(timer);
      timer =
        !dismissed && document.visibilityState === "visible"
          ? setTimeout(dismiss, after)
          : null;
    };

    restartCountdown();
    document.addEventListener("visibilitychange", restartCountdown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", restartCountdown);
    };
  }, [after, messageId]);
}

export const MultiStageProtonScreen = props => {
  const {
    autoAdvance,
    advanceOnExperimentLoad,
    handleAction,
    messageId,
    navigate,
    order,
  } = props;
  useAutoDismiss(props.autoDismiss, messageId);
  useEffect(() => {
    if (!autoAdvance && !advanceOnExperimentLoad) {
      return () => {};
    }

    if (autoAdvance) {
      const value = autoAdvance?.actionEl ?? autoAdvance;
      const timeout = autoAdvance?.actionTimeMS ?? DEFAULT_AUTO_ADVANCE_MS;

      const timer = setTimeout(() => {
        handleAction({
          currentTarget: {
            value,
          },
          name: "AUTO_ADVANCE",
        });
      }, timeout);
      return () => clearTimeout(timer);
    }

    // If not doing a standard auto advance, handle auto advancing when experiments load.

    // Defaults for when advance_on_experiment_load is true.
    const minMsDefault = 3000;
    const maxMsDefault = 8000;

    let minMs = advanceOnExperimentLoad?.minDisplayMs ?? minMsDefault;
    let maxMs = advanceOnExperimentLoad?.maxDisplayMs ?? maxMsDefault;

    // Ensure max >= min.
    if (maxMs < minMs) {
      maxMs = minMs;
    }

    const startTime = performance.now();
    let cancelled = false;
    let advanced = false;
    let minDone = false;
    let experimentsDone = false;
    let nimbusResult = null;
    let maxTimeoutFired = false;

    const doAdvance = () => {
      if (cancelled || advanced) {
        return;
      }
      advanced = true;

      const screen_duration = Math.round(performance.now() - startTime);
      let reason;
      if (maxTimeoutFired) {
        reason = "max_display_timeout";
      } else if (nimbusResult === "error") {
        reason = "nimbus_error";
      } else if (nimbusResult === "timeout") {
        reason = "nimbus_timeout";
      } else {
        reason = "nimbus_ready";
      }
      MultiStageUtils.sendActionTelemetry(
        messageId,
        "advance_on_experiment_load",
        "SPLASH_DISMISSED",
        { reason, screen_duration }
      );

      navigate(false);
    };

    const maybeAdvance = () => {
      if (minDone && experimentsDone) {
        doAdvance();
      }
    };

    const minTimerId = window.setTimeout(() => {
      minDone = true;
      maybeAdvance();
    }, minMs);

    const maxTimerId = window.setTimeout(() => {
      maxTimeoutFired = true;
      doAdvance();
    }, maxMs);

    // Use an IIFE to keep the effect itself synchronous
    (async () => {
      try {
        if (typeof window.AWWaitForNimbus === "function") {
          nimbusResult = await window.AWWaitForNimbus();
        }
        // If AWWaitForNimbus is missing, treat as "done" immediately.
      } catch (e) {
      } finally {
        experimentsDone = true;
        maybeAdvance();
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(minTimerId);
      window.clearTimeout(maxTimerId);
    };
  }, [
    autoAdvance,
    advanceOnExperimentLoad,
    handleAction,
    messageId,
    order,
    navigate,
  ]);

  // Set narrow on an outer element to allow for use of SCSS outer selector and
  // consolidation of styles for small screen widths with those for messages
  // configured to always be narrow
  if (props.content.narrow) {
    document
      .querySelector("#multi-stage-message-root")
      ?.setAttribute("narrow", "");
  } else {
    // Clear narrow attribute in case it was set by a previous screen
    document
      .querySelector("#multi-stage-message-root")
      ?.removeAttribute("narrow");
  }

  function useMediaQuery(query) {
    const [doesMatch, setDoesMatch] = useState(
      () => window.matchMedia(query).matches
    );

    useEffect(() => {
      const mediaQueryList = window.matchMedia(query);
      const onChange = event => setDoesMatch(event.matches);

      mediaQueryList.addEventListener("change", onChange);
      return () => mediaQueryList.removeEventListener("change", onChange);
    }, [query]);

    return doesMatch;
  }

  const isWideScreen = useMediaQuery("(min-width: 800px)");

  return (
    <ProtonScreen
      content={props.content}
      id={props.id}
      order={props.order}
      activeTheme={props.activeTheme}
      activeThemeId={props.activeThemeId}
      installedAddons={props.installedAddons}
      screenMultiSelects={props.screenMultiSelects}
      setScreenMultiSelects={props.setScreenMultiSelects}
      activeMultiSelect={props.activeMultiSelect}
      setActiveMultiSelect={props.setActiveMultiSelect}
      activeSingleSelectSelections={props.activeSingleSelectSelections}
      setActiveSingleSelectSelection={props.setActiveSingleSelectSelection}
      textInputs={props.textInputs}
      setTextInput={props.setTextInput}
      pinnedSites={props.pinnedSites}
      setPinnedSite={props.setPinnedSite}
      contentToggleChecked={props.contentToggleChecked}
      setContentToggleChecked={props.setContentToggleChecked}
      totalNumberOfScreens={props.totalNumberOfScreens}
      handleAction={props.handleAction}
      isFirstScreen={props.isFirstScreen}
      isLastScreen={props.isLastScreen}
      isSingleScreen={props.isSingleScreen}
      previousOrder={props.previousOrder}
      autoAdvance={props.autoAdvance}
      advanceOnExperimentLoad={props.advanceOnExperimentLoad}
      navigate={props.navigate}
      isRtamo={props.isRtamo}
      addonId={props.addonId}
      addonType={props.addonType}
      addonName={props.addonName}
      addonURL={props.addonURL}
      addonIconURL={props.addonIconURL}
      themeScreenshots={props.themeScreenshots}
      messageId={props.messageId}
      negotiatedLanguage={props.negotiatedLanguage}
      langPackInstallPhase={props.langPackInstallPhase}
      forceHideStepsIndicator={props.forceHideStepsIndicator}
      ariaRole={props.ariaRole}
      aboveButtonStepsIndicator={props.aboveButtonStepsIndicator}
      requireAction={props.requireAction}
      isWideScreen={isWideScreen}
      animationsPaused={props.animationsPaused}
      toggleAnimationsPaused={props.toggleAnimationsPaused}
    />
  );
};

export const ProtonScreenActionButtons = props => {
  const {
    content,
    isRtamo,
    addonId,
    addonType,
    addonName,
    activeMultiSelect,
    activeSingleSelectSelections,
    textInputs,
    pinnedSites,
    installedAddons,
  } = props;
  const defaultValue = content.checkbox?.defaultValue;

  const [isChecked, setIsChecked] = useState(defaultValue || false);
  const buttonRef = React.useRef(null);

  const shouldFocusButton = content?.primary_button?.should_focus_button;

  useEffect(() => {
    if (shouldFocusButton) {
      buttonRef.current?.focus();
    }
  }, [shouldFocusButton]);

  if (
    !content.primary_button &&
    !content.secondary_button &&
    !content.additional_button
  ) {
    return null;
  }

  if (isRtamo) {
    content.primary_button.label.string_id = addonType?.includes("theme")
      ? "return-to-amo-add-theme-label"
      : "mr1-return-to-amo-add-extension-label";
  }

  // If we have a multi-select screen, we want to disable the primary button
  // until the user has selected at least one item.
  const isPrimaryDisabled = disabledValue => {
    if (disabledValue === "hasActiveMultiSelect") {
      if (!activeMultiSelect) {
        return true;
      }

      // Check if there's at least one selection in any of the multiselects
      for (const selectKey in activeMultiSelect) {
        if (activeMultiSelect[selectKey]?.length > 0) {
          return false;
        }
      }
      return true;
    }
    // Only disables the primary button until at least one single-select
    // option is chosen.
    if (disabledValue === "hasActiveSingleSelect") {
      if (!activeSingleSelectSelections) {
        return true;
      }
      return !Object.values(activeSingleSelectSelections).some(
        val => val && val !== "none"
      );
    }
    if (disabledValue === "hasTextInput") {
      // For text input, we check if the user has entered any text in the
      // textarea(s) present on the screen.
      if (!textInputs) {
        return true;
      }
      return Object.values(textInputs).every(
        input => !input.isValid || input.value.trim().length === 0
      );
    }
    // Disables the primary button until the user has pinned at least one site.
    if (disabledValue === "hasPinnedSite") {
      return !pinnedSites;
    }
    return disabledValue;
  };

  return (
    <div
      className={`action-buttons ${
        content.additional_button ? "additional-cta-container" : ""
      }`}
      flow={content.additional_button?.flow}
      alignment={content.additional_button?.alignment}
    >
      {isRtamo ? (
        <InstallButton
          key={addonId}
          addonId={addonId}
          addonType={addonType}
          addonName={addonName}
          index={"primary_button"}
          handleAction={props.handleAction}
          installedAddons={installedAddons}
          install_label={content.primary_button.label}
          install_complete_label={content.primary_button.install_complete_label}
        />
      ) : (
        <Localized text={content.primary_button?.label}>
          <button
            ref={buttonRef}
            className={`${content.primary_button?.style ?? "primary"}${
              content.primary_button?.has_arrow_icon ? " arrow-icon" : ""
            }`}
            // Whether or not the checkbox is checked determines which action
            // should be handled. By setting value here, we indicate to
            // this.handleAction() where in the content tree it should take
            // the action to execute from.
            value={isChecked ? "checkbox" : "primary_button"}
            disabled={isPrimaryDisabled(content.primary_button?.disabled)}
            onClick={props.handleAction}
            data-l10n-args={
              addonName
                ? JSON.stringify({
                    "addon-name": addonName,
                  })
                : ""
            }
          />
        </Localized>
      )}
      {content.additional_button ? (
        <AdditionalCTA
          content={content}
          handleAction={props.handleAction}
          activeMultiSelect={activeMultiSelect}
          textInputs={textInputs}
        />
      ) : null}
      {content.checkbox ? (
        <div className="checkbox-container">
          <input
            type="checkbox"
            id="action-checkbox"
            checked={isChecked}
            onChange={() => {
              setIsChecked(!isChecked);
            }}
          ></input>
          <Localized text={content.checkbox.label}>
            <label htmlFor="action-checkbox"></label>
          </Localized>
        </div>
      ) : null}
      {content.secondary_button ? (
        <SecondaryCTA
          content={content}
          handleAction={props.handleAction}
          activeMultiSelect={activeMultiSelect}
          textInputs={textInputs}
        />
      ) : null}
    </div>
  );
};

export class ProtonScreen extends React.PureComponent {
  componentDidMount() {
    // Don't focus on main content if it is a feature callout
    // See Bug 1985939
    if (this.props.content?.position === "callout") {
      return;
    }

    // For requireAction screens, focus the title heading instead of the
    // alertdialog container.
    // Prevents Orca from misreading tab navigated elements.
    if (this.props.requireAction && this.titleHeader) {
      this.titleHeader.focus();
    } else {
      this.mainContentHeader.focus();
    }
  }

  getScreenClassName(
    includeNoodles,
    hasZapBorder,
    hasZapShadow,
    isVideoOnboarding,
    isAddonsPicker
  ) {
    if (isVideoOnboarding) {
      return "with-video";
    }

    if (isAddonsPicker) {
      return "addons-picker";
    }

    const screenClass = `screen-${this.props.order % 2 !== 0 ? 1 : 2}`;
    const dialogInitial =
      this.props.isFirstScreen && this.props.previousOrder < 0
        ? `dialog-initial`
        : ``;
    const dialogLast = this.props.isLastScreen ? `dialog-last` : ``;
    const zapBorder = hasZapBorder ? `zap-border` : ``;
    const zapShadow = hasZapShadow ? `zap-shadow` : ``;

    return `${screenClass} ${dialogInitial} ${dialogLast} ${zapBorder} ${zapShadow} ${includeNoodles ? `with-noodles` : ``}`;
  }

  renderTitle({ title, title_logo }) {
    const titleRef = this.props.requireAction
      ? input => {
          this.titleHeader = input;
        }
      : null;
    if (title_logo) {
      const { alignment, ...rest } = title_logo;
      return (
        <div
          className="inline-icon-container"
          alignment={alignment ?? "center"}
        >
          {this.renderPicture({ ...rest })}
          <Localized text={title}>
            <h1
              id="mainContentHeader"
              tabIndex={this.props.requireAction ? -1 : undefined}
              ref={titleRef}
            />
          </Localized>
        </div>
      );
    }
    return (
      <Localized text={title}>
        <h1
          id="mainContentHeader"
          tabIndex={this.props.requireAction ? -1 : undefined}
          ref={titleRef}
        />
      </Localized>
    );
  }

  renderPicture(image) {
    const {
      imageURL = "chrome://branding/content/about-logo.svg",
      darkModeImageURL,
      reducedMotionImageURL,
      darkModeReducedMotionImageURL,
      videoURL,
      alt = "",
      width,
      height,
      marginBlock,
      marginInline,
      style,
      imgStyle,
      className = "logo-container",
    } = resolveDirectionalImage(image);
    function getLoadingStrategy() {
      for (let url of [
        imageURL,
        darkModeImageURL,
        reducedMotionImageURL,
        darkModeReducedMotionImageURL,
      ]) {
        if (MultiStageUtils.getLoadingStrategyFor(url) === "lazy") {
          return "lazy";
        }
      }
      return "eager";
    }

    const containerStyle = {
      marginInline,
      marginBlock,
      ...style,
    };

    // videoURL lets this render a one-shot animation instead of a static image.
    // It plays once and holds its last frame. Users who prefer reduced motion
    // fall through to the static <picture>/<img> below.
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (videoURL && !prefersReducedMotion) {
      return (
        <div className={className} style={containerStyle}>
          <Localized text={alt}>
            <div className="sr-only logo-alt" />
          </Localized>
          <video
            className="brand-logo"
            style={{ height, width, ...imgStyle }}
            src={videoURL}
            autoPlay={true}
            muted={true}
            playsInline={true}
            role={alt ? null : "presentation"}
          />
        </div>
      );
    }

    return (
      <picture className={className} style={containerStyle}>
        {darkModeReducedMotionImageURL ? (
          <source
            srcset={darkModeReducedMotionImageURL}
            media="(prefers-color-scheme: dark) and (prefers-reduced-motion: reduce)"
          />
        ) : null}
        {darkModeImageURL ? (
          <source
            srcset={darkModeImageURL}
            media="(prefers-color-scheme: dark)"
          />
        ) : null}
        {reducedMotionImageURL ? (
          <source
            srcset={reducedMotionImageURL}
            media="(prefers-reduced-motion: reduce)"
          />
        ) : null}
        <Localized text={alt}>
          <div className="sr-only logo-alt" />
        </Localized>
        <img
          className="brand-logo"
          style={{ height, width, ...imgStyle }}
          src={imageURL}
          alt=""
          loading={getLoadingStrategy()}
          role={alt ? null : "presentation"}
        />
      </picture>
    );
  }

  renderNoodles() {
    return (
      <React.Fragment>
        <div className={"noodle orange-L"} />
        <div className={"noodle purple-C"} />
        <div className={"noodle solid-L"} />
        <div className={"noodle outline-L"} />
        <div className={"noodle yellow-circle"} />
      </React.Fragment>
    );
  }

  renderLastCardImage(content) {
    const { width, height, marginBlock, marginInline, ...image } =
      content.center_image ?? {};
    return (
      <div
        className="last-card-image"
        style={{
          "--last-card-image-width": width,
          "--last-card-image-height": height,
          "--last-card-picture-margin-block": marginBlock,
          "--last-card-picture-margin-inline": marginInline,
        }}
      >
        {content.center_image
          ? this.renderPicture({ ...image, className: "center-image" })
          : null}
      </div>
    );
  }

  // Draws the front card plus one back card for each screen still to come, up
  // to two.
  renderCardStackLayers() {
    const { order = 0, totalNumberOfScreens = 1 } = this.props;
    const cardsBehind = totalNumberOfScreens - order - 1;
    return (
      <>
        <div className="card-stack-front" />
        {cardsBehind >= 1 ? <div className="card-stack-layer-1" /> : null}
        {cardsBehind >= 2 ? <div className="card-stack-layer-2" /> : null}
      </>
    );
  }

  renderCornerImage(anchor) {
    const cornerImage = this.props.content.corner_image;
    const position = resolveCornerImagePosition(cornerImage.position);
    const entranceAnimation = cornerImage.entrance_animation ?? {};
    const entranceType = CORNER_IMAGE_ENTRANCE_ANIMATIONS.has(
      entranceAnimation.type
    )
      ? entranceAnimation.type
      : DEFAULT_CORNER_IMAGE_ENTRANCE_ANIMATION;

    return (
      <div className={"corner-image-container"}>
        {this.renderPicture({
          imageURL: cornerImage.imageURL,
          darkModeImageURL: cornerImage.darkModeImageURL,
          reducedMotionImageURL: cornerImage.reducedMotionImageURL,
          darkModeReducedMotionImageURL:
            cornerImage.darkModeReducedMotionImageURL,
          rtl: cornerImage.rtl,
          height: cornerImage.height,
          width: cornerImage.width,
          marginBlock: cornerImage.marginBlock,
          marginInline: cornerImage.marginInline,
          style: {
            // Read indirectly by _multistage.scss, so reduced motion can
            // override them. Undefined values fall through to its defaults.
            "--corner-image-entrance-distance": entranceAnimation.distance,
            "--corner-image-entrance-duration": entranceAnimation.duration,
            "--corner-image-entrance-delay": entranceAnimation.delay,
            ...cornerImage.style,
          },
          className: `corner-image ${position}${
            anchor === "screen" ? ` entrance-${entranceType}` : ""
          }`,
        })}
      </div>
    );
  }

  renderLanguageSwitcher() {
    return this.props.content.languageSwitcher ? (
      <LanguageSwitcher
        content={this.props.content}
        handleAction={this.props.handleAction}
        negotiatedLanguage={this.props.negotiatedLanguage}
        langPackInstallPhase={this.props.langPackInstallPhase}
        messageId={this.props.messageId}
      />
    ) : null;
  }

  renderDismissButton() {
    const { size, marginBlock, marginInline, label, background } =
      this.props.content.dismiss_button;
    return (
      <button
        className={`dismiss-button ${background ? "with-background" : ""}`}
        onClick={this.props.handleAction}
        value="dismiss_button"
        data-l10n-id={label?.string_id || "spotlight-dialog-close-button"}
        button-size={size}
        style={{ marginBlock, marginInline }}
      ></button>
    );
  }

  renderMoreButton() {
    return (
      <SubmenuButton
        content={this.props.content}
        handleAction={this.props.handleAction}
        buttonType="more"
      />
    );
  }

  renderStepsIndicator() {
    const {
      order,
      previousOrder,
      content,
      totalNumberOfScreens: total,
      aboveButtonStepsIndicator,
    } = this.props;
    const currentStep = (order ?? 0) + 1;
    const previousStep = (previousOrder ?? -1) + 1;
    return (
      <div
        id="steps"
        className={`steps${content.progress_bar ? " progress-bar" : ""}`}
        above-button={aboveButtonStepsIndicator ? "" : null}
        data-l10n-id={
          content.steps_indicator?.string_id ||
          "onboarding-welcome-steps-indicator-label"
        }
        data-l10n-args={JSON.stringify({
          current: currentStep,
          total: total ?? 0,
        })}
        data-l10n-attrs="aria-label"
        role="progressbar"
        aria-valuenow={currentStep}
        aria-valuemin={1}
        aria-valuemax={total}
      >
        {content.progress_bar ? (
          <ProgressBar
            step={currentStep}
            previousStep={previousStep}
            totalNumberOfScreens={total}
          />
        ) : (
          <StepsIndicator order={order} totalNumberOfScreens={total} />
        )}
      </div>
    );
  }

  // We consider a screen to have animated content when it includes both
  // default and _static versions of its background image or hero_image url.
  // The pause toggle swaps the rendered asset to the _static asset when activated.
  // Without _both_ default and static, there is nothing for the toggle to
  // switch to, so we don't render the toggle button at all.
  hasAnimatedContent(content) {
    return !!(
      (content.background && content.background_static) ||
      (content.hero_image?.url && content.hero_image?.static_url)
    );
  }

  getEffectiveBackground(content) {
    if (!["split", "card-stack"].includes(content.position)) {
      const gradient =
        content.zap_border_gradient ||
        "linear-gradient(96deg, #B89CFF 20.68%, #FF9565 79.34%)";
      const combinedBackground =
        content.background && content.zap_border
          ? `${gradient} border-box border-area, image(${content.background}) padding-box`
          : content.background;

      const combinedBackgroundStatic =
        content.background_static && content.zap_border
          ? `${gradient} border-box border-area, image(${content.background_static}) padding-box`
          : content.background_static;

      return this.props.animationsPaused && content.background_static
        ? combinedBackgroundStatic
        : combinedBackground;
    }
    return this.props.animationsPaused && content.background_static
      ? content.background_static
      : content.background;
  }

  getEffectiveHeroImageUrl(content) {
    if (!content.hero_image) {
      return null;
    }
    return this.props.animationsPaused && content.hero_image.static_url
      ? content.hero_image.static_url
      : content.hero_image.url;
  }

  renderAnimationPlayPauseButton() {
    const { toggleAnimationsPaused } = this.props;
    const paused = !!this.props.animationsPaused;
    const labelId = paused
      ? "onboarding-animation-play-button"
      : "onboarding-animation-pause-button";
    return (
      <button
        className={`animation-play-pause-button${paused ? " paused" : ""}`}
        type="button"
        aria-pressed={paused}
        data-l10n-id={labelId}
        onClick={toggleAnimationsPaused}
      />
    );
  }

  renderSecondarySection(content) {
    const background = this.getEffectiveBackground(content);
    const heroImageUrl = this.getEffectiveHeroImageUrl(content);
    const cardStackImageClass = content.card_stack_image
      ? `card-stack-image-${content.card_stack_image.type ?? "float"}`
      : "";
    const tiles = Array.isArray(content.tiles)
      ? content.tiles
      : [content.tiles];
    const isPinnableSites = tiles.some(tile => tile?.type === "pinnable_sites");
    let style = {};
    // compute the style prop depending on the message type
    if (content.position === "card-stack" && content.card_stack_image) {
      // set variables to use in the CSS
      style = {
        "--card-stack-bkg": background,
        "--card-stack-bkg-uncropped":
          content.card_stack_image.background_uncropped ?? background,
        "--card-stack-bkg-medium":
          content.card_stack_image.background_medium ?? background,
        "--card-stack-bkg-small":
          content.card_stack_image.background_small ?? background,
      };
    } else {
      // pinnable_sites exposes its background through a custom property so the
      // stylesheet can swap the wide-layout image for a narrow gradient without
      // overriding an inline `background` shorthand.
      style = background
        ? {
            [isPinnableSites ? "--pinnable-sites-bkg" : "background"]:
              background,
            "--mr-secondary-background-position-y":
              content.split_narrow_bkg_position,
          }
        : {};
    }
    return (
      <div
        className={`section-secondary ${
          content.hide_secondary_section ? "with-secondary-section-hidden" : ""
        } ${cardStackImageClass}`}
        style={style}
      >
        {content.dismiss_button && content.reverse_split
          ? this.renderDismissButton()
          : null}
        <Localized text={content.image_alt_text}>
          <div className="sr-only image-alt" role="img" />
        </Localized>
        {content.hero_image ? (
          <HeroImage url={heroImageUrl} />
        ) : (
          this.renderHeroText(content.hero_text)
        )}
        {this.hasAnimatedContent(content)
          ? this.renderAnimationPlayPauseButton()
          : null}
      </div>
    );
  }

  renderHeroText(hero_text) {
    if (!hero_text) {
      return null;
    }

    // Check if hero_text is a string or an object with string_id property
    // essentially checking if we're using old or new design
    const isSimpleText =
      typeof hero_text === "string" ||
      (typeof hero_text === "object" &&
        hero_text !== null &&
        ("string_id" in hero_text || "raw" in hero_text));

    const HeroTextWrapper = ({ children, className }) => (
      <React.Fragment>
        <div className={`message-text ${className}`}>
          <div className="spacer-top" />
          {children}
          <div className="spacer-bottom" />
        </div>
      </React.Fragment>
    );

    if (isSimpleText) {
      return (
        <HeroTextWrapper className="simple">
          <Localized text={hero_text}>
            <h1 />
          </Localized>
        </HeroTextWrapper>
      );
    }

    return (
      <HeroTextWrapper className="hero-text">
        <Localized text={hero_text.title}>
          <h1 />
        </Localized>
        {hero_text.subtitle && (
          <Localized text={hero_text.subtitle}>
            <h2 />
          </Localized>
        )}
      </HeroTextWrapper>
    );
  }

  renderOrderedContent(content) {
    const elements = [];
    for (const [index, item] of content.entries()) {
      switch (item.type) {
        case "text":
          elements.push(
            <LinkParagraph
              key={index}
              text_content={item}
              handleAction={this.props.handleAction}
            />
          );
          break;
        case "image":
          elements.push(
            <React.Fragment key={index}>
              {this.renderPicture({
                imageURL: item.url,
                darkModeImageURL: item.darkModeImageURL,
                height: item.height,
                width: item.width,
                alt: item.alt_text,
                marginInline: item.marginInline,
                className: "inline-image",
              })}
            </React.Fragment>
          );
      }
    }
    return <>{elements}</>;
  }

  renderRTAMOIcon(position, addonType, themeScreenshots, addonIconURL) {
    if (position === "center-large") {
      return (
        <div className="rtamo-icon-wrapper">
          <div className="rtamo-icon">
            <img
              className={`${addonType?.includes("theme") ? "rtamo-theme-icon" : "brand-logo"}`}
              src={
                addonType?.includes("theme")
                  ? themeScreenshots[0].url
                  : addonIconURL
              }
              loading={MultiStageUtils.getLoadingStrategyFor(addonIconURL)}
              alt=""
              role="presentation"
            />
          </div>
          <div className="logo-separator"></div>
          <div className="rtamo-logo">{this.renderPicture({})}</div>
        </div>
      );
    }

    return (
      <div className="rtamo-icon">
        <img
          className={`${addonType?.includes("theme") ? "rtamo-theme-icon" : "brand-logo"}`}
          src={
            addonType?.includes("theme")
              ? themeScreenshots[0].url
              : addonIconURL
          }
          loading={MultiStageUtils.getLoadingStrategyFor(addonIconURL)}
          alt=""
          role="presentation"
        />
      </div>
    );
  }

  getCombinedInnerStyles(content, isWideScreen) {
    const INNER_CONTENT_CONFIGURABLE_STYLES = [
      "overflow",
      "display",
      "paddingInline",
      "paddingInlineStart",
      "paddingInlineEnd",
      "paddingBlock",
      "paddingBlockStart",
      "paddingBlockEnd",
      "width",
      "minHeight",
      "flexGrow",
    ];

    const innerContentStyles = isWideScreen
      ? content.main_content_style || {}
      : content.main_content_style_narrow || {};

    const validInnerStyles =
      MultiStageUtils.getValidStyle(
        innerContentStyles,
        INNER_CONTENT_CONFIGURABLE_STYLES
      ) || {};

    return {
      ...validInnerStyles,
      justifyContent: content.split_content_justify_content,
    };
  }

  getActionButtonsPosition(content) {
    const VALID_POSITIONS = [
      "after_subtitle",
      "after_supporting_content",
      "end",
    ];

    if (VALID_POSITIONS.includes(content.action_buttons_position)) {
      return content.action_buttons_position;
    }
    // Legacy mapping
    if (content.action_buttons_above_content) {
      return "after_subtitle";
    }
    // Default
    return "end";
  }

  renderActionButtons(position, content) {
    return this.getActionButtonsPosition(content) === position ? (
      <ProtonScreenActionButtons
        content={content}
        isRtamo={this.props.isRtamo}
        installedAddons={this.props.installedAddons}
        addonId={this.props.addonId}
        addonName={this.props.addonName}
        addonType={this.props.addonType}
        handleAction={this.props.handleAction}
        activeMultiSelect={this.props.activeMultiSelect}
        activeSingleSelectSelections={this.props.activeSingleSelectSelections}
        textInputs={this.props.textInputs}
        pinnedSites={this.props.pinnedSites}
      />
    ) : null;
  }

  // eslint-disable-next-line complexity
  render() {
    const {
      autoAdvance,
      content,
      isRtamo,
      addonType,
      isSingleScreen,
      forceHideStepsIndicator,
      ariaRole,
      aboveButtonStepsIndicator,
      isWideScreen,
    } = this.props;
    const includeNoodles = content.has_noodles;
    const isCenterLargeFullscreen =
      content.position === "center-large" && !!content.fullscreen;
    // Where the corner image is anchored, which decides where it gets rendered.
    // The fullscreen FRO layout anchors to the window, so its container stays a
    // child of .screen. Every other layout anchors to the card instead, which
    // means rendering inside .section-main (the positioned card wrapper).
    let cornerImageAnchor = null;
    if (content.corner_image) {
      cornerImageAnchor = isCenterLargeFullscreen ? "screen" : "card";
    }
    const secondaryCTATop = content.secondary_button_top ? (
      <SecondaryCTA
        content={content}
        handleAction={this.props.handleAction}
        position="top"
      />
    ) : null;
    const hasZapBorder = content.zap_border;
    const hasZapShadow = content.zap_shadow;
    // The default screen position is "center"
    const isCenterPosition =
      ["center", "center-large"].includes(content.position) ||
      !content.position;
    const hideStepsIndicator =
      autoAdvance ||
      content?.video_container ||
      isSingleScreen ||
      forceHideStepsIndicator;
    const textColorClass = content.text_color
      ? `${content.text_color}-text`
      : "";
    // Assign proton screen style 'screen-1' or 'screen-2' to centered screens
    // by checking if screen order is even or odd.
    const screenClassName = isCenterPosition
      ? this.getScreenClassName(
          includeNoodles,
          hasZapBorder,
          hasZapShadow,
          content?.video_container,
          content.tiles?.type === "addons-picker"
        )
      : `${hasZapBorder ? "zap-border" : ""} ${hasZapShadow ? " zap-shadow" : ""}`;
    const isEmbeddedMigration = content.tiles?.type === "migration-wizard";
    const isSystemPromptStyleSpotlight =
      content.isSystemPromptStyleSpotlight === true;
    const combinedStyles = this.getCombinedInnerStyles(content, isWideScreen);
    // content.screen_style is a shared mix of screen-level layout tweaks
    // consumed by three different elements below (.screen, .section-main,
    // .main-content), each pulling its own allowlisted subset of it.
    const screenStyleJustifyContent =
      content.screen_style &&
      MultiStageUtils.getValidStyle(content.screen_style, ["justifyContent"])
        .justifyContent;

    return (
      <main
        className={`screen ${this.props.id || ""}
          ${screenClassName} ${textColorClass}`}
        reverse-split={content.reverse_split ? "" : null}
        fullscreen={content.fullscreen ? "" : null}
        style={{
          ...(content.screen_style &&
            MultiStageUtils.getValidStyle(content.screen_style, [
              "overflow",
              "display",
            ])),
          // center-large-fullscreen renders its background here, at the
          // full-viewport screen level, rather than on .main-content, so it
          // isn't confined to that inset card and can show behind the
          // blurred glow (see .main-content below).
          background: isCenterLargeFullscreen
            ? this.getEffectiveBackground(content)
            : null,
        }}
        role={ariaRole ?? "alertdialog"}
        layout={content.layout}
        pos={content.position || "center"}
        data-theme={
          content.position === "card-stack" && this.props.activeThemeId
            ? this.props.activeThemeId
            : null
        }
        tabIndex="-1"
        aria-labelledby={`mainContentHeader${content.subtitle ? " mainContentSubheader" : ""}`}
        aria-describedby="mainContentInner"
        ref={input => {
          this.mainContentHeader = input;
        }}
        no-rdm={content.no_rdm ? "" : null}
        // eslint-disable-next-line react/no-unknown-property
        initial-card={
          content.position === "card-stack" &&
          this.props.isFirstScreen &&
          this.props.previousOrder < 0
            ? ""
            : null
        }
      >
        {content.position === "card-stack"
          ? this.renderCardStackLayers()
          : null}
        {cornerImageAnchor === "screen"
          ? this.renderCornerImage("screen")
          : null}
        {isCenterPosition ? null : this.renderSecondarySection(content)}
        <div
          className={`section-main ${
            isEmbeddedMigration ? "embedded-migration" : ""
          }${isSystemPromptStyleSpotlight ? "system-prompt-spotlight" : ""}`}
          hide-secondary-section={
            content.hide_secondary_section
              ? String(content.hide_secondary_section)
              : null
          }
          role="document"
          style={
            content.screen_style &&
            MultiStageUtils.getValidStyle(content.screen_style, [
              "width",
              "padding",
              "height",
            ])
          }
        >
          {cornerImageAnchor === "card" ? this.renderCornerImage("card") : null}
          {isCenterLargeFullscreen ? null : secondaryCTATop}
          {includeNoodles ? this.renderNoodles() : null}
          {content.more_button ? this.renderMoreButton() : null}
          {content.dismiss_button && !content.reverse_split
            ? this.renderDismissButton()
            : null}
          <div
            className={`main-content ${hideStepsIndicator ? "no-steps" : ""}`}
            style={{
              background:
                isCenterPosition &&
                !isCenterLargeFullscreen &&
                this.getEffectiveBackground(content)
                  ? this.getEffectiveBackground(content)
                  : null,
              width:
                content.width &&
                !["split", "card-stack"].includes(content.position)
                  ? content.width
                  : null,
              paddingBlock: content.split_content_padding_block
                ? content.split_content_padding_block
                : null,
              paddingInline: content.split_content_padding_inline
                ? content.split_content_padding_inline
                : null,
              justifyContent: screenStyleJustifyContent,
            }}
          >
            {isCenterLargeFullscreen ? secondaryCTATop : null}
            {isCenterPosition && this.hasAnimatedContent(content)
              ? this.renderAnimationPlayPauseButton()
              : null}
            {content.logo && !content.fullscreen
              ? this.renderPicture(content.logo)
              : null}
            {isRtamo && !content.fullscreen
              ? this.renderRTAMOIcon(
                  content.position,
                  addonType,
                  this.props.themeScreenshots,
                  this.props.addonIconURL
                )
              : null}
            <div
              className="main-content-inner"
              id="mainContentInner"
              style={combinedStyles}
            >
              {content.logo && content.fullscreen
                ? this.renderPicture(content.logo)
                : null}
              {isRtamo && content.fullscreen
                ? this.renderRTAMOIcon(
                    content.position,
                    addonType,
                    this.props.themeScreenshots,
                    this.props.addonIconURL
                  )
                : null}
              {content.title || content.subtitle ? (
                <div
                  id="multi-stage-message-welcome-text"
                  className={`welcome-text ${content.title_style || ""}`}
                >
                  {content.title ? this.renderTitle(content) : null}
                  {content.layout === "last-card"
                    ? this.renderLastCardImage(content)
                    : null}
                  {content.subtitle ? (
                    <Localized text={content.subtitle}>
                      <h2
                        data-l10n-args={JSON.stringify({
                          "addon-name": this.props.addonName,
                          ...this.props.appAndSystemLocaleInfo?.displayNames,
                        })}
                        aria-flowto={
                          this.props.messageId?.includes("FEATURE_TOUR")
                            ? "steps"
                            : ""
                        }
                        id="mainContentSubheader"
                      />
                    </Localized>
                  ) : null}
                  {this.renderActionButtons("after_subtitle", content)}
                  {content.cta_paragraph ? (
                    <CTAParagraph
                      content={content.cta_paragraph}
                      handleAction={this.props.handleAction}
                    />
                  ) : null}
                </div>
              ) : null}
              {content.video_container ? (
                <OnboardingVideo
                  content={content.video_container}
                  handleAction={this.props.handleAction}
                />
              ) : null}
              {this.renderLanguageSwitcher()}
              {content?.tiles_container?.position !==
              "after_supporting_content" ? (
                <ContentTiles {...this.props} />
              ) : null}
              {content.above_button_content
                ? this.renderOrderedContent(content.above_button_content)
                : null}
              {this.renderActionButtons("after_supporting_content", content)}
              {content?.tiles_container?.position ===
              "after_supporting_content" ? (
                <ContentTiles {...this.props} />
              ) : null}
              {!hideStepsIndicator && aboveButtonStepsIndicator
                ? this.renderStepsIndicator()
                : null}
              {this.renderActionButtons("end", content)}
              {
                /* Fullscreen dot-style step indicator should sit inside the
              main inner content to share its padding, which will be
              configurable with Bug 1956042 */
                !hideStepsIndicator &&
                !aboveButtonStepsIndicator &&
                !content.progress_bar &&
                content.fullscreen
                  ? this.renderStepsIndicator()
                  : null
              }
            </div>
            {!hideStepsIndicator &&
            !aboveButtonStepsIndicator &&
            !(content.fullscreen && !content.progress_bar)
              ? this.renderStepsIndicator()
              : null}
          </div>
        </div>
        <Localized text={content.info_text}>
          <span className="info-text" />
        </Localized>
      </main>
    );
  }
}

const localizableThingPropTypes = PropTypes.oneOfType([
  PropTypes.string,
  PropTypes.exact({
    // A raw, untranslated string (typically used for EN-only experiments) or
    // an $l10n object.
    raw: PropTypes.oneOfType([
      PropTypes.string,
      PropTypes.exact({
        $l10n: PropTypes.exact({
          // A unique identifier for the string. It can only contain letters,
          // numbers, and hyphens (-).
          id: PropTypes.string,
          // The text of the string.
          text: PropTypes.string,
          // A comment used to provide more context to localizers.
          comment: PropTypes.string,
        }),
      }),
    ]),
    // Fluent string identifier from a .ftl file.
    string_id: PropTypes.string,
    // Arguments for Fluent strings that have variables.
    args: PropTypes.object,
    // A string to use as the element's aria-label attribute value.
    aria_label: PropTypes.string,
    // If true, uses the installed lang pack for the Fluent strings.
    useLangPack: PropTypes.bool,
    // Inline icons inside localized strings. Each entry maps a Fluent
    // data-l10n-name to an icon object.
    inline_icons: PropTypes.object,
    // Adds zap style and content.
    zap: PropTypes.oneOfType([PropTypes.bool, PropTypes.string]),
    // CSS overrides for configurable styles.
    ...Object.fromEntries(
      CONFIGURABLE_STYLES.map(key => [
        key,
        PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
      ])
    ),
  }),
]);

const actionPropTypes = PropTypes.exact({
  // The special message action id.
  type: PropTypes.string,
  // The data to pass to the action if needed.
  data: PropTypes.object,
  // If true, dismisses the screen. Can be used in addition to or instead of
  // a special message action type. If set to 'actionResult', the callout
  // will only be dismissed after the special message action has resolved
  // successfully, will only take effect for certain special message ids, and
  // requires setting 'needsAwait' to true.
  dismiss: PropTypes.oneOfType([PropTypes.string, PropTypes.bool]),
  // If true, the action needs to be awaited. Must be true if 'dismiss' is
  // set to 'actionResult'.
  needsAwait: PropTypes.oneOfType([PropTypes.string, PropTypes.bool]),
  // If true, navigates to the next step.
  navigate: PropTypes.oneOfType([PropTypes.string, PropTypes.bool]),
  // If true, goes back to the previous step.
  goBack: PropTypes.oneOfType([PropTypes.string, PropTypes.bool]),
  // If true, the actions for selected checkbox/radio selections are
  // performed in series. Set to true if this action is for the primary
  // button and the 'multiselect' tile is used.
  collectSelect: PropTypes.oneOfType([PropTypes.string, PropTypes.bool]),
  // If true, collects all text input on action.
  collectTextInput: PropTypes.oneOfType([PropTypes.string, PropTypes.bool]),
  // If true, collects content toggle state on action.
  collectContentToggleState: PropTypes.oneOfType([
    PropTypes.string,
    PropTypes.bool,
  ]),
  // Indicates that the action should navigate to a different screen.
  advance_screens: PropTypes.exact({
    // The behavior of the screen navigation. Behaves like 'dismiss'.
    behavior: PropTypes.oneOfType([PropTypes.string, PropTypes.bool]),
    // How many screens and in which direction to advance. Positive integers
    // advance forward while negative integers advance backward.
    direction: PropTypes.number,
    // The id of the screen to advance to. Id takes priority if both id and
    // direction are provided.
    id: PropTypes.string,
  }),
  // If true, adds flow parameters to the action.
  addFlowParams: PropTypes.bool,
  // If true, sends dismiss telemetry when the action is performed.
  sendDismissTelemetry: PropTypes.bool,
  // page_event_listeners actions only. If true, repositions the callout.
  reposition: PropTypes.oneOfType([PropTypes.string, PropTypes.bool]),
  // If true, only fires on the screen's first view.
  once: PropTypes.bool,
  // For tile actions only. The theme to apply. '<event>' uses the selected
  // element's value.
  theme: PropTypes.string,
  // For tile actions only. '<event>' handles the selected element's value as
  // a picker selection.
  picker: PropTypes.string,
  // For tile actions only. If true, saves the active theme as the initial
  // theme to revert to.
  persistActiveTheme: PropTypes.bool,
});

const buttonPropTypes = PropTypes.exact({
  // The text to show inside the button. For dismiss buttons, it is optionally
  // used to control the aria attributes and tooltip.
  label: localizableThingPropTypes,
  // The JEXL targeting for conditional button display. Only available for
  // secondary buttons.
  targeting: PropTypes.string,
  // The special message action invoked if the button is clicked.
  action: actionPropTypes,
  // If true, shows an arrow icon next to the label. Only available for primary
  // and secondary buttons.
  has_arrow_icon: PropTypes.bool,
  // If true, disables the button. If set to 'hasActiveMultiSelect', disables
  // the button until the user selects something in the multiselect tiles. If
  // set to 'hasTextInput', disables the button while the textarea tile is
  // empty or exceeds the character limit. If set to 'hasActiveSingleSelect',
  // disables the button until the user selects an option in the single-select
  // tile (only available for primary buttons). If set to 'hasPinnedSite',
  // disables the button until the screen has had at least one successful pin
  // (only available for primary buttons).
  disabled: PropTypes.oneOfType([
    PropTypes.oneOf([
      "hasActiveMultiSelect",
      "hasTextInput",
      "hasActiveSingleSelect",
      "hasPinnedSite",
    ]),
    PropTypes.bool,
  ]),
  // Overrides the style of the button. "link" is only available for additional
  // buttons.
  style: PropTypes.oneOf(["primary", "secondary", "link"]),
  // The text for the RTAMO install button, provided in the primary button.
  install_complete_label: localizableThingPropTypes,
  // If true, the primary button will be focused when the screen is displayed.
  should_focus_button: PropTypes.bool,
  // If there are several buttons, this property of an additional button can
  // control the orientation of all the buttons.
  flow: PropTypes.oneOf(["row", "column"]),
  // Extra text to show before a secondary button.
  text: localizableThingPropTypes,
  // If there are several buttons, this property of an additional button can
  // control the justification and alignment of the buttons row/column.
  // Defaults to 'end'.
  alignment: PropTypes.oneOf(["end", "start", "space-between"]),
  // The size of the dismiss_button (20px, 24px, 32px). Defaults to 32px.
  size: PropTypes.oneOf(["x-small", "small", "large"]),
  // If true, adds a background to the dismiss button.
  background: PropTypes.bool,
  // CSS override for the marginBlock property.
  marginBlock: PropTypes.string,
  // CSS override for the marginInline property.
  marginInline: PropTypes.string,
});

const textPropTypes = PropTypes.oneOfType([
  localizableThingPropTypes,
  PropTypes.arrayOf(
    PropTypes.oneOfType([
      // Plain text.
      PropTypes.string,
      PropTypes.exact({
        // Embedded URL link. Dispatches OPEN_URL with `args: href`.
        href: PropTypes.string,
        // OPEN_URL `where` argument. Defaults to "tab". Only meaningful
        // alongside `href`.
        where: PropTypes.string,
        // Inline link key. Resolved against
        // `screen.content[link_key].action`. Mutually exclusive with
        // `href`; if both are set, `href` wins.
        link_key: PropTypes.string,
        // An action to dispatch when the link is clicked, specified
        // inline rather than looked up by key. Takes precedence over
        // `href` and `link_key`. When `href` is also set it is still
        // rendered on the anchor (so the link has a visible target and
        // context menu), but the click dispatches this action instead of
        // OPEN_URL.
        action: actionPropTypes,
        // Reported as the telemetry `source` when this segment's link is
        // clicked. Only used alongside `action`; `link_key` segments
        // report the link key instead.
        id: PropTypes.string,
        // A raw, untranslated string (typically used for EN-only
        // experiments) or an $l10n object.
        raw: PropTypes.oneOfType([
          PropTypes.string,
          PropTypes.exact({
            $l10n: PropTypes.exact({
              // A unique identifier for the string. It can only contain
              // letters, numbers, and hyphens (-).
              id: PropTypes.string,
              // The text of the string.
              text: PropTypes.string,
              // A comment used to provide more context to localizers.
              comment: PropTypes.string,
            }),
          }),
        ]),
        // Fluent string identifier from a .ftl file.
        string_id: PropTypes.string,
        // Arguments for Fluent strings that have variables.
        args: PropTypes.object,
        // A string to use as the element's aria-label attribute value.
        aria_label: PropTypes.string,
        // If true, uses the installed lang pack for the Fluent strings.
        useLangPack: PropTypes.bool,
        // Inline icons inside localized strings. Each entry maps a
        // Fluent data-l10n-name to an icon object.
        inline_icons: PropTypes.object,
        // Adds zap style and content.
        zap: PropTypes.oneOfType([PropTypes.bool, PropTypes.string]),
        // CSS overrides for configurable styles.
        ...Object.fromEntries(
          CONFIGURABLE_STYLES.map(key => [
            key,
            PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
          ])
        ),
      }),
      PropTypes.shape({
        // The URL of the inline image.
        imageURL: PropTypes.string,
        // Optional alternative URL used in RTL locales.
        rtlImageURL: PropTypes.string,
        // <img> alt text. Defaults to ''. Not backed by Fluent, so set it here
        // rather than in a Fluent string.
        alt: PropTypes.string,
      }),
    ])
  ),
]);

const sharedContentTilesProps = {
  // CSS overrides of the content tile. Any CSS properties starting with '--'
  // are also allowed.
  style: PropTypes.object,
  // The content tile id.
  id: PropTypes.string,
  // The content tile header.
  header: PropTypes.exact({
    // The tile header title.
    title: localizableThingPropTypes,
    // The tile header subtitle.
    subtitle: localizableThingPropTypes,
    // The tile header title if the tile type is a textbox and the
    // contentToggleChecked is false.
    alternateTitle: localizableThingPropTypes,
    // CSS overrides of the tile header.
    style: PropTypes.exact({
      ...Object.fromEntries(
        HEADER_STYLES.map(key => [
          key,
          PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
        ])
      ),
    }),
    // If true, adds the link-style class to the tile header.
    linkStyle: PropTypes.bool,
  }),
  // The content tile title.
  title: localizableThingPropTypes,
  // The content tile subtitle.
  subtitle: localizableThingPropTypes,
};

const addonsPickerDataPropTypes = PropTypes.exact({
  // The addon container key ID.
  id: PropTypes.string,
  // The name of the addon.
  name: localizableThingPropTypes,
  // The type of the addon.
  type: PropTypes.string,
  // The description of the addon.
  description: localizableThingPropTypes,
  // The icon of the addon.
  icon: PropTypes.string,
  // The optional author of the addon.
  author: PropTypes.exact({
    byLine: localizableThingPropTypes,
    id: PropTypes.string,
    name: PropTypes.string,
  }),
  // The label for the addon install button.
  install_label: localizableThingPropTypes,
  // The complete label for the addon install button.
  install_complete_label: localizableThingPropTypes,
  // The action for the addon install button.
  action: actionPropTypes,
  // The source ID inside the click button telemetry ping sent by the
  // addon install button.
  source_id: PropTypes.string,
});

const singleSelectDataPropTypes = PropTypes.exact({
  // Optionally used to control the aria description.
  description: localizableThingPropTypes,
  // If true, prevents the single-select tile from being clickable and usable.
  inert: PropTypes.bool,
  // The icon displayed for the single select tile.
  icon: PropTypes.shape({ background: PropTypes.string }),
  // The id of the single select tile.
  id: PropTypes.string,
  // Text displayed in the single select tile with label-text styling.
  label: localizableThingPropTypes,
  // Items or text displayed below the label text.
  body: PropTypes.oneOfType([
    localizableThingPropTypes,
    PropTypes.exact({
      items: PropTypes.arrayOf(
        PropTypes.exact({
          icon: PropTypes.object,
          text: localizableThingPropTypes,
          style: PropTypes.object,
        })
      ),
    }),
  ]),
  // Text displayed below the label and body texts with subtitle-text
  // styling.
  subtitle: localizableThingPropTypes,
  // The theme to be applied when the tile is clicked.
  theme: PropTypes.string,
  // Optional hover tooltip for the single select tile.
  tooltip: localizableThingPropTypes,
  // Optional type defined for the single select tile for styling.
  type: PropTypes.string,
  // Optional flair text.
  flair: PropTypes.shape({
    centered: PropTypes.bool,
    spacer: PropTypes.bool,
    text: localizableThingPropTypes,
  }),
  // CSS overrides for the single select tile.
  style: PropTypes.object,
  // Optional button that can be added to the single select tile.
  tilebutton: PropTypes.shape({
    label: localizableThingPropTypes,
    style: PropTypes.oneOf(["primary", "secondary"]),
    action: actionPropTypes,
  }),
  // JEXL targeting evaluated to determine whether or not to display this
  // single select tile item.
  targeting: PropTypes.string,
  // The pill inside the pill navigation component corresponding to this single
  // select tile.
  pill: PropTypes.exact({
    label: localizableThingPropTypes,
    icon: PropTypes.string,
  }),
});

const multiSelectDataPropTypes = PropTypes.exact({
  // A unique id for this multiselect item.
  id: PropTypes.string,
  // The type of multiselect item.
  type: PropTypes.oneOf(["checkbox", "radio"]),
  // Required for radio types. Set the same group for radios to ensure
  // only one of them can be selected at a time.
  group: PropTypes.string,
  // The default checked/unchecked value of the multiselect item.
  defaultValue: PropTypes.bool,
  // The JEXL targeting that determines whether or not to show this
  // multiselect item.
  targeting: PropTypes.string,
  // The label for the multiselect item.
  label: localizableThingPropTypes,
  // Supporting copy for the item, rendered as a paragraph after the
  // label and wired to the checkbox with `aria-describedby`. In the
  // "select-card" and "grouped-card" designs it becomes a second,
  // deemphasized line beneath the label.
  description: localizableThingPropTypes,
  // The special message action performed when the user clicks the
  // primary button.
  action: actionPropTypes,
  // If true, randomizes the order of the multiselect items. By
  // default, the items appear in the order they're listed in the data
  // array.
  randomize: PropTypes.bool,
  // CSS overrides for the div box containing the item and label.
  style: PropTypes.object,
  // An optional icon that can replace the checkbox/radio buttons using
  // CSS overrides.
  icon: PropTypes.exact({ style: PropTypes.object }),
  // A note shown below the item when it is unchecked, which disappears
  // when checked. The note is rendered in an `aria-live` region that
  // is always present in the DOM, so assistive technology announces it
  // when it appears. It is laid out as a full-width row beneath the
  // item, so it is meant for wide surfaces such as about:welcome or a
  // fullscreen Spotlight. It is not compatible with
  // `multiSelectItemDesign: "picker"`, and is not recommended in a
  // feature callout panel, which is too narrow for it.
  uncheckedNotice: PropTypes.exact({
    title: localizableThingPropTypes,
    subtitle: localizableThingPropTypes,
    iconURL: PropTypes.string,
  }),
});

const actionChecklistDataPropTypes = PropTypes.exact({
  // The key of the action checklist item.
  id: PropTypes.string,
  // The source ID used in telemetry pings.
  source_id: PropTypes.string,
  // JEXL targeting that is evaluated to determine if this action item has been
  // completed or not.
  targeting: PropTypes.string,
  // Text for the action checklist item.
  label: localizableThingPropTypes,
  // The special message action invoked when the action checklist item is
  // clicked.
  action: actionPropTypes,
  // If true, shows the external link icon.
  showExternalLinkIcon: PropTypes.bool,
});

const pinnableSitesDataPropTypes = PropTypes.exact({
  // The pinnable site item key.
  id: PropTypes.string,
  // The name of the pinnable site item.
  name: localizableThingPropTypes,
  // The description of the pinnable site item.
  description: localizableThingPropTypes,
  // The URL of the icon inside the pinnable site item.
  iconUrl: PropTypes.string,
  // The pinnable site URL.
  url: PropTypes.string,
  // Sent in PIN_SITE telemetry ping.
  personalized: PropTypes.bool,
  // The title of the pinnable site item.
  title: localizableThingPropTypes,
});

const tilePropType = PropTypes.oneOfType([
  PropTypes.exact({
    // The type of tile. More details can be found in ContentTiles.jsx.
    type: PropTypes.oneOf(["link"]).isRequired,
    // The action for link, single-select, or theme tiles.
    action: actionPropTypes,
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in AddonsPicker.jsx.
    type: PropTypes.oneOf(["addons-picker"]).isRequired,
    // Tile configurations needed for the tile type.
    data: PropTypes.oneOfType([
      addonsPickerDataPropTypes,
      PropTypes.arrayOf(addonsPickerDataPropTypes),
    ]),
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in SingleSelect.jsx.
    type: PropTypes.oneOf(["theme", "single-select"]).isRequired,
    category: PropTypes.exact({
      type: PropTypes.oneOf(["theme", "single-select"]),
    }),
    // The action for link, single-select, or theme tiles.
    action: actionPropTypes,
    // The id of an item inside `data` that will be the default selected
    // item.
    selected: PropTypes.string,
    // If true and applicable, automatically triggers the action for the
    // default selected tile.
    autoTrigger: PropTypes.bool,
    // Optional. Currently for single-select tiles only. Visual layout for
    // the tile's items; 'carousel' lays the items out in a single row,
    // centered on the selected item, with pill navigation above. The row has
    // two sizes: in a modal at least 800px wide the selected card is
    // enlarged and its neighbours peek in at a smaller size, and below that
    // every card takes the smaller size and the selection is marked by its
    // outline alone.
    layout: PropTypes.oneOf(["carousel"]),
    // Optional. Currently for single-select tiles only, and only applies
    // when 'layout' is 'carousel'. Accessible name for the carousel pill
    // navigation.
    pill_nav_label: localizableThingPropTypes,
    // Tile configurations needed for the tile type.
    data: PropTypes.oneOfType([
      singleSelectDataPropTypes,
      PropTypes.arrayOf(singleSelectDataPropTypes),
    ]),
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in MobileDownloads.jsx.
    type: PropTypes.oneOf(["mobile_downloads"]).isRequired,
    // Tile configurations needed for the tile type.
    data: PropTypes.exact({
      // An optional QR code to display in the tile to encourage users to
      // download Firefox.
      QR_code: PropTypes.exact({
        image_url: PropTypes.string,
        alt_text: localizableThingPropTypes,
      }),
      // An optional email link that users can use to email themselves a
      // download link.
      email: PropTypes.exact({
        link_text: PropTypes.string,
      }),
    }),
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in MultiSelect.jsx.
    type: PropTypes.oneOf(["multiselect"]).isRequired,
    // Alternate presentations for the multiselect items.
    multiSelectItemDesign: PropTypes.oneOf([
      "picker",
      "select-card",
      "grouped-card",
    ]),
    // Optional text for a multistage multiselect label.
    label: localizableThingPropTypes,
    // Optional text for a multistage multiselect footer label.
    footer: PropTypes.exact({
      checkedLabel: localizableThingPropTypes,
      unCheckAllLabel: localizableThingPropTypes,
    }),
    // Tile configurations needed for the tile type.
    data: PropTypes.oneOfType([
      multiSelectDataPropTypes,
      PropTypes.arrayOf(multiSelectDataPropTypes),
    ]),
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in TextAreaTile.jsx.
    type: PropTypes.oneOf(["textarea"]).isRequired,
    // Tile configurations needed for the tile type. Using this tile type
    // requires a `write_in_microsurvey: true` inside the message content to
    // apply the write-in microsurvey data policy. This is REQUIRED for all
    // write-in microsurveys. Messages using the textarea tile should always
    // set this to true. It prevents `client_id` from being recorded with any
    // telemetry events for the message, recording a unique `impression_id`
    // instead. It also sends the events on the `microsurvey` ping instead of the
    // `messaging-system` ping, which is anonymized by OHTTP, has stricter access
    // control, and is retained for a shorter period. It still allows counting
    // unique impressions and joining pings from the same message, but it can't
    // be joined to any other telemetry data. So all events coming from a message
    // with this set to true will be joinable by `impression_id`, but
    // disconnected from other datasets. Optional; defaults to false if omitted.
    data: PropTypes.exact({
      // The textarea tile id.
      id: PropTypes.string,
      // The character limit set for the textarea.
      character_limit: PropTypes.number,
      // CSS overrides for the textarea container div.
      container_style: PropTypes.object,
      // CSS overrides for the textarea character counter div.
      char_counter_style: PropTypes.object,
      // CSS overrides for the textarea.
      textarea_style: PropTypes.object,
      // The number of rows for the textarea.
      rows: PropTypes.number,
      // The number of columns for the textarea.
      column: PropTypes.number,
      // Optional placeholder text in the textarea.
      placeholder: PropTypes.string,
    }),
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in
    // EmbeddedMigrationWizard.jsx.
    type: PropTypes.oneOf(["migration-wizard"]).isRequired,
    // Optional configuration options for the migration wizard.
    migration_wizard_options: PropTypes.exact({
      // If true, force show import all options.
      force_show_import_all: PropTypes.bool,
      // The title string for the option expander.
      option_expander_title_string: PropTypes.string,
      // If true, hides the option expander subtitle.
      hide_option_expander_subtitle: PropTypes.bool,
      // The success message string after import completion.
      data_import_complete_success_string: PropTypes.string,
      // The header string for the selection section.
      selection_header_string: PropTypes.string,
      // The subheader string for the selection section.
      selection_subheader_string: PropTypes.string,
      // If true, hides the select all option.
      hide_select_all: PropTypes.bool,
      // The inline margin for checkboxes.
      checkbox_margin_inline: PropTypes.string,
      // The block margin for checkboxes.
      checkbox_margin_block: PropTypes.string,
      // The text string for the import button.
      import_button_string: PropTypes.string,
      // The CSS class for the import button.
      import_button_class: PropTypes.string,
      // The font size for the header.
      header_font_size: PropTypes.string,
      // The font weight for the header.
      header_font_weight: PropTypes.string,
      // The block margin for the header.
      header_margin_block: PropTypes.string,
      // The font size for the subheader.
      subheader_font_size: PropTypes.string,
      // The font weight for the subheader.
      subheader_font_weight: PropTypes.string,
      // The block margin for the subheader.
      subheader_margin_block: PropTypes.string,
    }),
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in
    // EmbeddedThemePicker.jsx.
    type: PropTypes.oneOf(["theme-picker"]).isRequired,
    // Tile configurations needed for the tile type.
    data: PropTypes.exact({
      // The install source for this theme picker component.
      installSource: PropTypes.string,
    }),
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in ActionChecklist.jsx.
    type: PropTypes.oneOf(["action_checklist"]).isRequired,
    // Tile configurations needed for the tile type.
    data: PropTypes.oneOfType([
      actionChecklistDataPropTypes,
      PropTypes.arrayOf(actionChecklistDataPropTypes),
    ]),
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in EmbeddedBrowser.jsx.
    type: PropTypes.oneOf(["embedded_browser"]).isRequired,
    // Tile configurations needed for the tile type.
    data: PropTypes.exact({
      // The URL to open inside the embedded browser component.
      url: PropTypes.string,
      // CSS overrides for the embedded browser component.
      style: PropTypes.object,
    }),
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in
    // EmbeddedBackupRestore.jsx.
    type: PropTypes.oneOf(["backup_restore"]).isRequired,
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in
    // EmbeddedFxBackupOptIn.jsx.
    type: PropTypes.oneOf(["fx_backup_file_path", "fx_backup_password"])
      .isRequired,
    // Configuration options for the embedded Fx Backup opt-in component.
    options: PropTypes.exact({
      // If true, then this is the file chooser screen.
      hide_password_input: PropTypes.bool,
      // If true, hides the secondary button.
      hide_secondary_button: PropTypes.bool,
      // The l10n id for the file path label.
      file_path_label: PropTypes.string,
      // The l10n id for the turn on backup header.
      turn_on_backup_header: PropTypes.string,
      // The l10n id for the create password label.
      create_password_label: PropTypes.string,
      // The l10n id for the confirmation label for turning on backup.
      turn_on_backup_confirm_btn_label: PropTypes.string,
      // The l10n id for the cancellation label for turning on backup.
      turn_on_backup_cancel_btn_label: PropTypes.string,
    }),
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in
    // ConfirmationChecklist.jsx.
    type: PropTypes.oneOf(["confirmation-checklist"]).isRequired,
    // Tile configurations needed for the tile type.
    data: PropTypes.exact({
      // CSS overrides for the confirmation checklist container.
      style: PropTypes.object,
      // The confirmation checklist items.
      items: PropTypes.arrayOf(
        PropTypes.exact({
          // The icon for this confirmation checklist item.
          icon: PropTypes.shape({
            background: PropTypes.string,
          }),
          // The text for this confirmation checklist item.
          text: localizableThingPropTypes,
          // The subtext for this confirmation checklist item. Can support
          // <a data-l10n-name></a> markers inside the Fluent string that can
          // be paired with `link_keys`.
          subtext: localizableThingPropTypes,
          // Each item corresponds to a <a data-l10n-name></a> marker inside
          // the subtext Fluent string.
          link_keys: PropTypes.arrayOf(PropTypes.string),
        })
      ),
    }),
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in PinnableSitesList.jsx.
    type: PropTypes.oneOf(["pinnable_sites"]).isRequired,
    // Where the tile draws its sites from. 'curated' (the default) uses the
    // authored 'data' array. 'topFrecentSites' replaces it with the user's
    // own most-used origins, computed locally from history. Currently only
    // supported in Spotlight.
    source: PropTypes.oneOf(["curated", "topFrecentSites"]),
    // How many tiles the surface shows. Defaults to 5.
    slots: PropTypes.number,
    // Only when source is 'topFrecentSites'. The fewest personalized origins
    // the tile must produce for the message to be shown at all. When the
    // user's history yields fewer, the message is withheld and records no
    // impression. Defaults to 0, which permits an entirely backfilled,
    // curated tile. A value above 'slots' always withholds the message, as
    // does a tile left with no sites at all.
    minPersonalized: PropTypes.number,
    // When personalization yields fewer origins than 'slots', fill the
    // remaining slots from the authored 'data' array rather than leaving
    // them blank. Defaults to true.
    backfill: PropTypes.bool,
    // A label for an optional pin button.
    pinButtonLabel: localizableThingPropTypes,
    // If true, applies the always-visible styling on the pinnable sites
    // list.
    alwaysShowPinButton: PropTypes.bool,
    // Tile configurations needed for the tile type.
    data: PropTypes.oneOfType([
      pinnableSitesDataPropTypes,
      PropTypes.arrayOf(pinnableSitesDataPropTypes),
    ]),
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in ContentToggle.jsx.
    type: PropTypes.oneOf(["content-toggle"]).isRequired,
    // Tile configurations needed for the tile type.
    data: PropTypes.exact({
      // The tile data id.
      id: PropTypes.string,
      // The content toggle label.
      label: localizableThingPropTypes,
      // If false, hides the content toggle label.
      visible: PropTypes.bool,
    }),
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in TextBoxTile.jsx.
    type: PropTypes.oneOf(["textbox"]).isRequired,
    // Tile configurations needed for the tile type.
    data: PropTypes.exact({
      // The tile data id.
      id: PropTypes.string,
      // Content inside the textbox-input.
      content: PropTypes.string,
      // Alternate content inside the textbox-input when the content is
      // toggled.
      alternateContent: PropTypes.string,
      // CSS overrides for the textbox-input.
      style: PropTypes.exact({
        backgroundColor: PropTypes.string,
        maxHeight: PropTypes.string,
      }),
    }),
    ...sharedContentTilesProps,
  }),
  PropTypes.exact({
    // The type of tile. More details can be found in LinkParagraph.jsx.
    type: PropTypes.oneOf(["text"]).isRequired,
    // The paragraph text.
    text: textPropTypes,
    // Optional paragraph style.
    font_styles: PropTypes.string,
    // Each item corresponds to a <a data-l10n-name></a> marker inside
    // the text Fluent string.
    link_keys: PropTypes.arrayOf(PropTypes.string),
    ...sharedContentTilesProps,
  }),
]);

export const screenContentShape = {
  // The layout position of the screen.
  position: PropTypes.oneOf([
    "center",
    "center-large",
    "split",
    "callout",
    "card-stack",
  ]),
  // If true, the screens are displayed in fullscreen.
  fullscreen: PropTypes.bool,
  // If true, the progress bar will be shown. Defaults to true.
  progress_bar: PropTypes.oneOfType([PropTypes.bool, PropTypes.string]),
  // The default CSS background for the screen.
  background: PropTypes.string,
  // The static CSS background for the screen, provided if the default
  // background has any animated content.
  background_static: PropTypes.string,
  // The hero image in the content.
  hero_image: PropTypes.exact({
    // The default URL of the hero image.
    url: PropTypes.string,
    // The URL of the static hero image, provided if the default hero image
    // has animated content.
    static_url: PropTypes.string,
  }),
  // The image to insert into the secondary section background
  // if the screen is a card stack. "Float" is the default
  // and uses the "background" property under the hood, so no
  // extra URLs are needed.
  card_stack_image: PropTypes.exact({
    // The image type; 'float' is a centered floating image (default),
    // 'bleed' is an image designed to bleed over the bottom edge of the
    // card, and 'banner' is a wider image that will bleed over two edges,
    // and convert to a centered image at smaller widths.
    type: PropTypes.oneOf(["float", "bleed", "banner"]),
    // The static CSS background to use with the 'bleed' image type.
    background_uncropped: PropTypes.string,
    // The static CSS background to use at the middle breakpoint
    // for the 'banner' image type.
    background_medium: PropTypes.string,
    // The static CSS background to use at the smallest breakpoint
    // for the 'banner' image type.
    background_small: PropTypes.string,
  }),
  // A single checkbox action.
  checkbox: PropTypes.exact({
    // The text to show next to the checkbox.
    label: localizableThingPropTypes,
    // The default value of the checkbox.
    defaultValue: PropTypes.bool,
    // The special message action invoked if the checkbox is selected.
    action: actionPropTypes,
  }),
  // The primary button.
  primary_button: buttonPropTypes,
  // The secondary button.
  secondary_button: buttonPropTypes,
  // The secondary button(s) that are displayed at the top of the screen, above
  // the main content.
  secondary_button_top: PropTypes.oneOfType([
    buttonPropTypes,
    PropTypes.arrayOf(buttonPropTypes),
  ]),
  // The additional button.
  additional_button: buttonPropTypes,
  // The dismiss button.
  dismiss_button: buttonPropTypes,
  // A submenu button that can be attached to another button.
  submenu_button: PropTypes.exact({
    // Optionally used to control the aria label and can be used to override
    // CSS styles.
    label: localizableThingPropTypes,
    // Overrides the style of the button. Should be set to the same style as
    // the button it's attached to.
    style: PropTypes.oneOf(["primary", "secondary"]),
    // The dropdown menu that appears when the user clicks the split button.
    submenu: PropTypes.arrayOf(
      PropTypes.exact({
        // A submenu item can be one of three types.
        type: PropTypes.oneOf(["action", "menu", "separator"]).isRequired,
        // The id used to identify the submenu item in telemetry.
        id: PropTypes.string,
        // The text to show inside the submenu item.
        label: localizableThingPropTypes,
        // Used only for type 'action'. The special message action invoked if
        // the submenu item is clicked.
        action: actionPropTypes,
        // An optional URL specifying an icon to show next to the label.
        icon: PropTypes.string,
        // Used only for type 'menu'. The submenu items to show when the user
        // hovers over this item. Recursive.
        submenu: PropTypes.arrayOf(PropTypes.object),
      })
    ),
    // The button that the submenu split button is attached to.
    attached_to: PropTypes.oneOf(["secondary_button", "additional_button"]),
  }),
  // Hides the secondary section.
  hide_secondary_section: PropTypes.string,
  // The background position for narrow split layouts.
  split_narrow_bkg_position: PropTypes.string,
  // If true, the callout hides on outside clicks.
  autohide: PropTypes.bool,
  // The callout card width as a CSS value.
  width: PropTypes.string,
  // The callout card padding as a CSS value.
  padding: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  // A layout variant for the screen. 'inline' is a single row layout that
  // works well in tandem with title_logo. 'last-card' is the final card-stack
  // screen, with the title and subtitle split around a centered image slot.
  layout: PropTypes.oneOf(["inline", "last-card", "survey"]),
  // If true, adds a colorful gradient border to the screen. This is only
  // supported for screens with 'hide_arrow' set to true. There is no effect
  // if HCM or a custom theme add-on is enabled.
  zap_border: PropTypes.bool,
  // If true, adds a colorful gradient shadow to the screen. This is only
  // supported for screens with 'hide_arrow' set to true and either
  // 'absolute_position' or 'arrow_position'. There is no effect if HCM or a
  // custom theme add-on is enabled.
  zap_shadow: PropTypes.bool,
  // If present, a custom gradient to use in conjunction with the
  // 'background' and 'zap_border' properties. Only applied if
  // both other properties are present.
  zap_border_gradient: PropTypes.string,
  // An optional object representing a large illustration to show above other
  // content.
  logo: PropTypes.exact({
    // The image URL.
    imageURL: PropTypes.string,
    // The dark mode image URL.
    darkModeImageURL: PropTypes.string,
    // The reduced motion image URL.
    reducedMotionImageURL: PropTypes.string,
    // The dark mode reduced motion image URL.
    darkModeReducedMotionImageURL: PropTypes.string,
    // A video URL, played once, instead of the images above. Ignored (falls
    // back to the image URLs above) for users who prefer reduced motion.
    videoURL: PropTypes.string,
    // Right-to-left replacements for any of the URLs above, applied over them
    // when the document is RTL. Omitted keys keep their base value.
    rtl: PropTypes.exact({
      imageURL: PropTypes.string,
      darkModeImageURL: PropTypes.string,
      reducedMotionImageURL: PropTypes.string,
      darkModeReducedMotionImageURL: PropTypes.string,
      videoURL: PropTypes.string,
    }),
    // The <img> alt text.
    alt: localizableThingPropTypes,
    // The CSS style overriding the width property.
    width: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The CSS style overriding the height property.
    height: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The CSS style overriding the marginBlock property.
    marginBlock: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The CSS style overriding the marginInline property.
    marginInline: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The style of the image container.
    style: PropTypes.object,
    // More style overrides applied to the <img> element.
    imgStyle: PropTypes.object,
  }),
  // An optional object representing an illustration anchored to a corner of the
  // screen. The fullscreen center-large layout anchors it to the window; every
  // other layout anchors it to the card.
  corner_image: PropTypes.exact({
    // The image URL.
    imageURL: PropTypes.string,
    // The dark mode image URL.
    darkModeImageURL: PropTypes.string,
    // The reduced motion image URL.
    reducedMotionImageURL: PropTypes.string,
    // The dark mode reduced motion image URL.
    darkModeReducedMotionImageURL: PropTypes.string,
    // Right-to-left replacements for any of the URLs above, applied over them
    // when the document is RTL. Omitted keys keep their base value.
    rtl: PropTypes.exact({
      imageURL: PropTypes.string,
      darkModeImageURL: PropTypes.string,
      reducedMotionImageURL: PropTypes.string,
      darkModeReducedMotionImageURL: PropTypes.string,
    }),
    // The corner the illustration is anchored to. Defaults to 'bottom-right'.
    // The -start/-end values are direction-relative and resolve against the
    // text direction, so they mirror in RTL; the left/right values are always
    // that physical corner.
    position: PropTypes.oneOf([
      "bottom-left",
      "bottom-right",
      "top-left",
      "top-right",
      "bottom-start",
      "bottom-end",
      "top-start",
      "top-end",
    ]),
    // The CSS style overriding the width property.
    width: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The CSS style overriding the height property.
    height: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The CSS style overriding the marginBlock property.
    marginBlock: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The CSS style overriding the marginInline property.
    marginInline: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // CSS overrides applied to the illustration container. Avoid 'translate'
    // and 'scale' when using 'entrance_animation', which animates those two
    // properties and would be overridden by them. 'transform' is unaffected.
    style: PropTypes.object,
    // How the illustration animates in each time the screen is entered. The
    // direction is derived from 'position', so a 'bottom-left' illustration
    // rises and a 'top-left' one descends. Every type degrades to an
    // opacity-only fade for users who prefer reduced motion.
    entrance_animation: PropTypes.exact({
      // The animation to run. Defaults to 'none'.
      type: PropTypes.oneOf([
        "none",
        "fade",
        "slide-block",
        "slide-inline",
        "slide-corner",
        "zoom",
      ]),
      // The CSS length the illustration travels, for the 'slide-*' types.
      distance: PropTypes.string,
      // The CSS time the animation takes.
      duration: PropTypes.string,
      // The CSS time to wait before starting, for staggering the illustration
      // against the screen's other content.
      delay: PropTypes.string,
    }),
  }),
  // An optional image shown in the center image slot of the 'last-card'
  // layout, revealed once the text split animation completes.
  center_image: PropTypes.exact({
    // The image URL.
    imageURL: PropTypes.string,
    // The dark mode image URL.
    darkModeImageURL: PropTypes.string,
    // The reduced motion image URL.
    reducedMotionImageURL: PropTypes.string,
    // The dark mode reduced motion image URL.
    darkModeReducedMotionImageURL: PropTypes.string,
    // Right-to-left replacements for any of the URLs above, applied over them
    // when the document is RTL. Any keys omitted keep their base values.
    rtl: PropTypes.exact({
      imageURL: PropTypes.string,
      darkModeImageURL: PropTypes.string,
      reducedMotionImageURL: PropTypes.string,
      darkModeReducedMotionImageURL: PropTypes.string,
    }),
    // The <img> alt text.
    alt: localizableThingPropTypes,
    // A video URL, played once, instead of the images above. Ignored (falls
    // back to the image URLs above) for users who prefer reduced motion.
    videoURL: PropTypes.string,
    // The CSS width of the image slot. The split animation and margins adapt
    // to it. Defaults to 120px.
    width: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The CSS height of the image slot. Defaults to 120px.
    height: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The CSS style overriding the marginBlock property. Useful for aligning
    // the image's focal point with the text. Only applies when the text is
    // split around the image, not when stacked at narrow breakpoints.
    marginBlock: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The CSS style overriding the marginInline property. Only applies when
    // the text is split around the image, not when stacked at narrow breakpoints.
    marginInline: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The style of the image container.
    style: PropTypes.object,
    // More style overrides applied to the <img> element.
    imgStyle: PropTypes.object,
  }),
  // The text for the headline.
  title: localizableThingPropTypes,
  // An optional object representing an icon to show next to the title.
  title_logo: PropTypes.exact({
    // The image URL.
    imageURL: PropTypes.string,
    // The dark mode image URL.
    darkModeImageURL: PropTypes.string,
    // The reduced motion image URL.
    reducedMotionImageURL: PropTypes.string,
    // The dark mode reduced motion image URL.
    darkModeReducedMotionImageURL: PropTypes.string,
    // Right-to-left replacements for any of the URLs above, applied over them
    // when the document is RTL. Any keys omitted keep their base values.
    rtl: PropTypes.exact({
      imageURL: PropTypes.string,
      darkModeImageURL: PropTypes.string,
      reducedMotionImageURL: PropTypes.string,
      darkModeReducedMotionImageURL: PropTypes.string,
    }),
    // The <img> alt text.
    alt: localizableThingPropTypes,
    // A video URL, played once, instead of the images above. Ignored (falls
    // back to the image URLs above) for users who prefer reduced motion.
    videoURL: PropTypes.string,
    // The CSS style overriding the width property.
    width: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The CSS style overriding the height property.
    height: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The CSS style overriding the marginBlock property.
    marginBlock: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The CSS style overriding the marginInline property.
    marginInline: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    // The logo alignment relative to the title.
    alignment: PropTypes.oneOf(["top", "center", "bottom"]),
    // The style of the image container.
    style: PropTypes.object,
    // More style overrides applied to the <img> element.
    imgStyle: PropTypes.object,
  }),
  // Optional styling for the title.
  title_style: PropTypes.oneOf(["fancy", "shine", "fancy shine"]),
  // The text to show below the title.
  subtitle: localizableThingPropTypes,
  // An extra block of configurable content below the title/subtitle but above
  // the main buttons. Can be placed above the 'tiles' by setting
  // 'tiles_container.position' to 'after_supporting_content'.
  above_button_content: PropTypes.arrayOf(
    PropTypes.shape({
      // The type of content.
      type: PropTypes.oneOf(["text", "image"]),
      // The paragraph text. Can be either a localizableThing that can be
      // combined with 'link_key's to attach actions to the
      // `<a data-l10n-name='...'>` or an array of either raw strings or a
      // localizableThing with 'href'/'link_key'/neither.
      text: textPropTypes,
      // A list of the link keys that exist in screen.content. The value of
      // that key must be an object with an 'action' property and the
      // 'string_id' in the 'text' object must refer to a Fluent string that
      // contains an anchor element with `data-l10n-name='LINK_KEY_NAME'`.
      link_keys: PropTypes.arrayOf(PropTypes.string),
      // Optional paragraph style.
      font_styles: PropTypes.oneOf(["legal"]),
    })
  ),
  // Optionally used to override the aria attributes or tooltip of the steps
  // indicator. Not recommended.
  steps_indicator: PropTypes.exact({
    string_id: PropTypes.string,
  }),
  // Tile object(s) to display on the screen, rendered in ContentTiles.jsx.
  tiles: PropTypes.oneOfType([PropTypes.arrayOf(tilePropType), tilePropType]),
  // The tiles container.
  tiles_container: PropTypes.exact({
    // The position of the tiles container relative to supporting content like
    // 'above_button_content'. By default, it comes before the supporting
    // content.
    position: PropTypes.oneOf(["after_supporting_content"]),
    // CSS overrides.
    style: PropTypes.exact({
      ...Object.fromEntries(
        CONTAINER_STYLES.map(key => [
          key,
          PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
        ])
      ),
    }),
  }),
  // The header for a tiles container.
  tiles_header: PropTypes.exact({
    title: localizableThingPropTypes.isRequired,
  }),
  // If true, applies the reverse split layout onto the screen (i.e., inverts
  // the visual order of the split screens).
  reverse_split: PropTypes.bool,
  // The <img> alt text.
  image_alt_text: localizableThingPropTypes,
  // The hero text.
  hero_text: PropTypes.oneOfType([
    localizableThingPropTypes,
    PropTypes.exact({
      title: localizableThingPropTypes,
      subtitle: localizableThingPropTypes,
    }),
  ]),
  // CSS overrides for the main content style on wide screens.
  main_content_style: PropTypes.object,
  // CSS overrides for the main content style on narrow screens.
  main_content_style_narrow: PropTypes.object,
  // A CSS override allowing custom justify content on split screens.
  split_content_justify_content: PropTypes.string,
  // The action button position.
  action_buttons_position: PropTypes.oneOf([
    "after_subtitle",
    "after_supporting_content",
    "end",
  ]),
  // If true, displays action buttons above main content.
  action_buttons_above_content: PropTypes.oneOfType([
    PropTypes.bool,
    PropTypes.string,
  ]),
  // If true, adds noodle illustrations that peek out behind the screen.
  has_noodles: PropTypes.bool,
  // If true, sets the narrow attribute on the outer element of the screen.
  narrow: PropTypes.bool,
  // The language switcher component that appears if there is a language
  // mismatch screen.
  languageSwitcher: PropTypes.exact({
    downloading: localizableThingPropTypes,
    cancel: localizableThingPropTypes,
    waiting: localizableThingPropTypes,
    skip: localizableThingPropTypes,
    switch: localizableThingPropTypes,
    continue: localizableThingPropTypes,
    action: actionPropTypes,
  }),
  // Displays the OnboardingVideo component.
  video_container: PropTypes.exact({
    // The URL of the video to play.
    video_url: PropTypes.string,
    // If true, autoplay is enabled for the video.
    autoPlay: PropTypes.bool,
  }),
  // Overrides all text color on the screen.
  text_color: PropTypes.oneOf(["light", "dark"]),
  // If true, overrides the Spotlight screen styling to look like the system
  // prompt style.
  isSystemPromptStyleSpotlight: PropTypes.bool,
  // CSS overrides for the screen style.
  screen_style: PropTypes.exact({
    overflow: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    display: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    height: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    width: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    padding: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    justifyContent: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  }),
  // If true, prevents the Spotlight from entering responsive design mode at
  // widths less than 800px.
  no_rdm: PropTypes.bool,
  // The CSS override for the paddingBlock styling for split layout contents.
  split_content_padding_block: PropTypes.oneOfType([
    PropTypes.string,
    PropTypes.number,
  ]),
  // The CSS override for the paddingInline styling for split layout contents.
  split_content_padding_inline: PropTypes.oneOfType([
    PropTypes.string,
    PropTypes.number,
  ]),
  // Text below the subtitle that can include hyperlinks.
  cta_paragraph: PropTypes.exact({
    // The text to be displayed.
    text: PropTypes.shape({
      // The Fluent string id for the paragraph text.
      string_id: PropTypes.string,
      // The name of the `<a data-l10n-name=''></a>` marker inside the
      // string_id.
      string_name: PropTypes.string,
    }),
    // The special message action to be invoked when the CTA text is clicked.
    action: actionPropTypes,
    // CSS style overrides for the paragraph text.
    style: PropTypes.object,
    // The icon to be displayed next to the CTA text.
    icon: PropTypes.shape({
      iconURL: PropTypes.string,
    }),
    // If true, applies the info-tile styling to the CTA paragraph.
    info_tile: PropTypes.bool,
  }),
  // Info text displayed at the bottom of the screen.
  info_text: localizableThingPropTypes,
  // If true, displays the encrypted backup method as part of the
  // 'fx_backup_file_path' or 'fx_backup_password' tile type.
  isEncryptedBackup: PropTypes.bool,
  // The action for the migration start event as part of the embedded migration
  // wizard component within about:welcome.
  migrate_start: PropTypes.exact({ action: actionPropTypes.isRequired }),
  // The action for the migration close event as part of the embedded migration
  // wizard component within about:welcome.
  migrate_close: PropTypes.exact({ action: actionPropTypes.isRequired }),
  // The subtitle text for the action checklist.
  action_checklist_subtitle: localizableThingPropTypes,
  // The remove checklist button in the action checklist.
  remove_checklist_button: PropTypes.exact({
    // The text inside the remove checklist button.
    label: localizableThingPropTypes,
    // The id used to identify the button in telemetry.
    source_id: PropTypes.string,
    // The special message action to invoke when the button is clicked.
    action: actionPropTypes,
  }),
  // A submenu button with a button type of 'more'.
  more_button: PropTypes.exact({
    submenu: PropTypes.arrayOf(
      PropTypes.exact({
        // A submenu item can be one of three types.
        type: PropTypes.oneOf(["action", "menu", "separator"]),
        // The id used to identify the submenu item in telemetry.
        id: PropTypes.string,
        // The text to show inside the submenu item.
        label: localizableThingPropTypes,
        // Used only for type 'action'. The special message action invoked if
        // the submenu item is clicked.
        action: actionPropTypes,
        // An optional URL specifying an icon to show next to the label.
        icon: PropTypes.string,
        // Used only for type 'menu'. The submenu items to show when the user
        // hovers over this item. Recursive.
        submenu: PropTypes.arrayOf(PropTypes.object),
      })
    ),
    // Overrides the style of the button.
    style: PropTypes.oneOf(["primary", "secondary"]),
  }),
  // A skip button that is passed into the EmbeddedBackupRestore content tile.
  skip_button: buttonPropTypes,
  // An optional array of event listeners to add to the page where the screen
  // is shown.
  page_event_listeners: PropTypes.arrayOf(
    PropTypes.exact({
      params: PropTypes.exact({
        // The event type string. Supports any DOM event type, timeout and
        // interval for timers, and internal feature callout events
        // 'touradvance' and 'tourend'.
        type: PropTypes.string,
        // The target selector.
        selector: PropTypes.string,
        // addEventListener options.
        options: PropTypes.exact({
          // If true, handles events in the capture phase.
          capture: PropTypes.bool,
          // If true, removes the listener after the first event.
          once: PropTypes.bool,
          // If true, prevents the default action in the event handler.
          preventDefault: PropTypes.bool,
          // Used only for timeout and interval event types to invoke the action
          // on a timer.
          interval: PropTypes.number,
          // If true, adds the listener to all windows.
          every_window: PropTypes.bool,
        }),
      }),
      // The special message action to be invoked.
      action: actionPropTypes,
    })
  ),
  // A special message action that fires automatically when the screen is first
  // shown.
  impression_action: actionPropTypes,
  // An action to perform when the Escape key is pressed, or when a page event
  // listener invokes an action containing `dismiss: true`. Unnecessary if
  // your message has a dismiss_button.
  dismiss_action: actionPropTypes,
  // By default, hitting Escape will dismiss the callout, whether it is focused
  // or not. Setting this to true will stop keypresses from dispatching up to
  // the callout from outside it, though they will still work when the callout
  // is focused. Best to leave this as-is.
  ignorekeys: PropTypes.bool,
  // Set to true for RTAMO screens in about:welcome.
  isRtamo: PropTypes.bool,
  // The CSS backdrop for the content.
  backdrop: PropTypes.string,
  backup_show_filepicker: PropTypes.shape({ action: actionPropTypes }),

  // Add any `link_key` properties that are used in messages in
  //    OnboardingMessageProvider.sys.mjs,
  //    FeatureCalloutMessages.sys.mjs, and
  //    PanelTestProvider.sys.mjs,
  // to prevent the propTypes validation unit test from throwing an invalid
  // prop error.
  here: PropTypes.object,
  settings: PropTypes.object,
  ios: PropTypes.object,
  android: PropTypes.object,
  terms_of_use: PropTypes.object,
  privacy_notice: PropTypes.object,
  "learn-more": PropTypes.object,
  email_link: PropTypes.object,
};

const screenContentPropTypes = PropTypes.exact(screenContentShape);

// Update PropTypes here and in `screenContentShape` whenever any content
// properties are added/removed. See MultiStageProtonScreenSchemas.json for a
// more detailed, non-enforcing schema of the multistage screen content
// properties.
MultiStageProtonScreen.propTypes = {
  // The unique identifier of the screen content. Each screen in a
  // message should have a different ID, which can be referenced in
  // actions to update the tour pref and advance screens.
  id: PropTypes.string.isRequired,
  // The main content of this screen.
  content: screenContentPropTypes,
};
