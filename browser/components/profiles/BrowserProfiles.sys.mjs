/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
  PanelMultiView:
    "moz-src:///browser/components/customizableui/PanelMultiView.sys.mjs",
  PanelView:
    "moz-src:///browser/components/customizableui/PanelMultiView.sys.mjs",
  SelectableProfileService:
    "resource:///modules/profiles/SelectableProfileService.sys.mjs",
});

/**
 * Manages the profile menus of a browser window. Each window has its own
 * instance, which `forWindow` creates on first use and `init` sets up.
 */
export class BrowserProfiles {
  static #instances = new WeakMap();

  /**
   * @param {Window} window
   * @returns {BrowserProfiles} The window's instance.
   */
  static forWindow(window) {
    let instance = BrowserProfiles.#instances.get(window);
    if (!instance) {
      instance = new BrowserProfiles(window);
      BrowserProfiles.#instances.set(window, instance);
    }
    return instance;
  }

  /**
   * @param {Window} window
   */
  static init(window) {
    return BrowserProfiles.forWindow(window).init();
  }

  #window;

  #subViewProfile;

  /**
   * @param {Window} window The browser window whose profile menus this
   *   manages.
   */
  constructor(window) {
    this.#window = window;
  }

  async init() {
    let { document, PanelUI } = this.#window;
    this.copyProfile = this.copyProfile.bind(this);
    this.createNewProfile = this.createNewProfile.bind(this);
    this.handleCommand = this.handleCommand.bind(this);
    this.launchProfile = this.launchProfile.bind(this);
    this.manageProfiles = this.manageProfiles.bind(this);
    this.onPopupShowing = this.onPopupShowing.bind(this);
    this.toggleProfileMenus = this.toggleProfileMenus.bind(this);
    this.updateView = this.updateView.bind(this);

    this.bundle = Services.strings.createBundle(
      "chrome://browser/locale/browser.properties"
    );

    this.profilesButton = lazy.PanelMultiView.getViewNode(
      document,
      "appMenu-profiles-button"
    );
    this.appMenuCreateProfileButton = lazy.PanelMultiView.getViewNode(
      document,
      "appMenu-create-profile-button"
    );
    this.fxaMenuProfileButtonsContainer = lazy.PanelMultiView.getViewNode(
      document,
      "PanelUI-fxa-menu-profile-buttons"
    );
    this.fxaMenuProfilesHeaderLabel = lazy.PanelMultiView.getViewNode(
      document,
      "PanelUI-fxa-menu-profiles-header-label"
    );
    this.fxaMenuProfilesSeparator = lazy.PanelMultiView.getViewNode(
      document,
      "PanelUI-fxa-menu-profiles-separator"
    );
    this.fxaMenuAllProfilesPanel = lazy.PanelMultiView.getViewNode(
      document,
      "PanelUI-fxa-menu-all-profiles"
    );
    this.fxaMenuAllProfilesPanel.addEventListener(
      "command",
      this.handleCommand
    );
    this.subview = lazy.PanelMultiView.getViewNode(
      document,
      "PanelUI-profiles"
    );
    this.subview.addEventListener("command", this.handleCommand);

    PanelUI.mainView.addEventListener("ViewShowing", () =>
      this.#onPanelShowing(this.profilesButton)
    );

    let fxaPanelView = lazy.PanelMultiView.getViewNode(document, "PanelUI-fxa");
    fxaPanelView.addEventListener("ViewShowing", () =>
      this.#onFxaMenuPanelShowing()
    );

    this.profilesButton.addEventListener("command", this.handleCommand);
    this.appMenuCreateProfileButton.addEventListener(
      "command",
      this.handleCommand
    );

    this.fxaMenuProfileButtonsContainer.addEventListener(
      "command",
      this.handleCommand
    );

    lazy.PanelMultiView.getViewNode(
      document,
      "PanelUI-fxa-menu-create-profile"
    ).addEventListener("command", this.handleCommand);

    // moz-button emits "click" rather than "command".
    lazy.PanelMultiView.getViewNode(
      document,
      "PanelUI-fxa-menu-create-profile-confirm-button"
    ).addEventListener("click", this.handleCommand);

    this.toggleProfileMenus(lazy.SelectableProfileService?.isEnabled);

    if (lazy.SelectableProfileService) {
      let listener = (event, isEnabled) => this.toggleProfileMenus(isEnabled);

      lazy.SelectableProfileService.on("enableChanged", listener);
      this.#window.addEventListener("unload", () =>
        lazy.SelectableProfileService.off("enableChanged", listener)
      );
    }
  }

  toggleProfileMenus(isEnabled) {
    let { document } = this.#window;
    let profilesMenu = document.getElementById("profiles-menu");
    profilesMenu.hidden = !isEnabled;
  }

  async #onPanelShowing(profilesButton) {
    if (!lazy.SelectableProfileService?.isEnabled) {
      profilesButton.hidden = true;
      this.appMenuCreateProfileButton.hidden = true;
      return;
    }

    // If the feature is preffed on, but we haven't created profiles yet, the
    // service will not be initialized.
    let profiles = lazy.SelectableProfileService.initialized
      ? await lazy.SelectableProfileService.getAllProfiles()
      : [];
    if (!profiles.length) {
      profilesButton.hidden = true;
      this.appMenuCreateProfileButton.hidden = false;
      return;
    }
    this.appMenuCreateProfileButton.hidden = true;

    profilesButton.hidden = false;

    let { themeBg, themeFg } =
      lazy.SelectableProfileService.currentProfile.theme;
    profilesButton.style.setProperty("--appmenu-profiles-theme-bg", themeBg);
    profilesButton.style.setProperty("--appmenu-profiles-theme-fg", themeFg);
    profilesButton.setAttribute(
      "label",
      lazy.SelectableProfileService.currentProfile.name
    );
    profilesButton.setAttribute(
      "image",
      await lazy.SelectableProfileService.currentProfile.getAvatarURL(16)
    );
  }

  async #onFxaMenuPanelShowing() {
    let { document } = this.#window;
    const container = this.fxaMenuProfileButtonsContainer;
    const headerLabel = this.fxaMenuProfilesHeaderLabel;
    const separator = this.fxaMenuProfilesSeparator;

    const hideProfilesSection = () => {
      container.hidden = true;
      headerLabel.hidden = true;
      separator.hidden = true;
    };

    const showProfilesSection = () => {
      container.hidden = false;
      headerLabel.hidden = false;
      separator.hidden = false;
    };

    if (!lazy.SelectableProfileService?.isEnabled) {
      hideProfilesSection();
      return;
    }

    let profiles = lazy.SelectableProfileService.initialized
      ? await lazy.SelectableProfileService.getAllProfiles()
      : [];

    while (container.lastChild) {
      container.lastChild.remove();
    }

    // When there are no user created profiles, surface a
    // call to action to create a new profile instead of the profile list.
    if (!profiles.length) {
      let createBtn = document.createXULElement("toolbarbutton");
      createBtn.id = "PanelUI-fxa-menu-create-profile-button";
      createBtn.classList.add(
        "subviewbutton",
        "subviewbutton-iconic",
        "subviewbutton-nav"
      );
      createBtn.setAttribute("closemenu", "none");
      createBtn.setAttribute("data-l10n-id", "appmenu-create-profile2");
      container.appendChild(createBtn);

      showProfilesSection();
      return;
    }

    let currentProfileId = lazy.SelectableProfileService.currentProfile?.id;
    profiles.sort((a, b) => {
      if (a.id === currentProfileId) {
        return -1;
      }
      if (b.id === currentProfileId) {
        return 1;
      }
      return 0;
    });

    for (let profile of profiles.slice(0, 3)) {
      let btn = document.createXULElement("toolbarbutton");
      btn.classList.add(
        "subviewbutton",
        "subviewbutton-iconic",
        "profile-item"
      );
      if (profile.id === lazy.SelectableProfileService.currentProfile?.id) {
        btn.classList.add("subviewbutton-nav");
      }
      btn.setAttribute("closemenu", "none");
      btn.setAttribute("profileid", profile.id);
      btn.setAttribute("label", profile.name);
      let { themeBg, themeFg } = profile.theme;
      btn.style.setProperty("--appmenu-profiles-theme-bg", themeBg);
      btn.style.setProperty("--appmenu-profiles-theme-fg", themeFg);
      let avatarURL = await profile.getAvatarURL(16);
      btn.setAttribute("image", avatarURL);
      container.appendChild(btn);
    }

    if (profiles.length > 3) {
      let allBtn = document.createXULElement("toolbarbutton");
      allBtn.id = "PanelUI-fxa-menu-all-profiles-button";
      allBtn.classList.add("subviewbutton", "subviewbutton-nav");
      allBtn.setAttribute("closemenu", "none");
      allBtn.setAttribute("data-l10n-id", "appmenu-all-profiles");
      container.appendChild(allBtn);
    }

    showProfilesSection();
  }

  async #populateAllProfilesPanel() {
    let { document } = this.#window;
    const list = lazy.PanelMultiView.getViewNode(
      document,
      "PanelUI-fxa-menu-all-profiles-list"
    );

    while (list.lastChild) {
      list.lastChild.remove();
    }

    let profiles = lazy.SelectableProfileService.initialized
      ? await lazy.SelectableProfileService.getAllProfiles()
      : [];

    let currentProfileId = lazy.SelectableProfileService.currentProfile?.id;
    profiles.sort((a, b) => {
      if (a.id === currentProfileId) {
        return -1;
      }
      if (b.id === currentProfileId) {
        return 1;
      }
      return 0;
    });

    for (let profile of profiles) {
      let btn = document.createXULElement("toolbarbutton");
      btn.classList.add(
        "subviewbutton",
        "subviewbutton-iconic",
        "profile-item"
      );
      btn.setAttribute("profileid", profile.id);
      let { themeBg, themeFg } = profile.theme;
      btn.style.setProperty("--appmenu-profiles-theme-bg", themeBg);
      btn.style.setProperty("--appmenu-profiles-theme-fg", themeFg);

      if (profile.id === currentProfileId) {
        btn.setAttribute("closemenu", "none");
        btn.setAttribute("align", "center");

        let icon = document.createXULElement("image");
        icon.classList.add("toolbarbutton-icon");
        icon.setAttribute("src", await profile.getAvatarURL(16));
        btn.appendChild(icon);

        let labelVbox = document.createXULElement("vbox");
        labelVbox.classList.add("toolbarbutton-text", "profile-item-labels");

        let mainLabel = document.createXULElement("label");
        mainLabel.setAttribute("value", profile.name);
        mainLabel.setAttribute("crop", "end");
        labelVbox.appendChild(mainLabel);

        let currentLabel = document.createXULElement("label");
        document.l10n.setAttributes(
          currentLabel,
          "appmenu-profile-current-in-use"
        );
        currentLabel.classList.add("profile-item-current-label");
        labelVbox.appendChild(currentLabel);

        btn.appendChild(labelVbox);

        let checkIcon = document.createXULElement("image");
        checkIcon.classList.add("profile-item-check-icon");
        checkIcon.setAttribute("src", "chrome://global/skin/icons/check.svg");
        btn.appendChild(checkIcon);
      } else {
        btn.setAttribute("label", profile.name);
        btn.setAttribute("image", await profile.getAvatarURL(16));
      }

      list.appendChild(btn);
    }
  }

  /**
   * Draws the menubar panel contents.
   */
  async onPopupShowing() {
    let { document } = this.#window;
    let menuPopup = document.getElementById("menu_ProfilesPopup");
    let profiles = await lazy.SelectableProfileService.getAllProfiles();
    let currentProfile = lazy.SelectableProfileService.currentProfile;
    let insertionPoint = document.getElementById("menu_newProfile");
    let existingItems = [
      ...menuPopup.querySelectorAll(":scope > menuitem[profileid]"),
    ];
    for (let profile of profiles) {
      let menuitem = existingItems.shift();
      let isNewItem = !menuitem;
      if (isNewItem) {
        menuitem = document.createXULElement("menuitem");
        menuitem.classList.add("menuitem-iconic", "menuitem-iconic-profile");
        menuitem.setAttribute("command", "Profiles:LaunchProfile");
      }
      let { themeBg, themeFg } = profile.theme;
      menuitem.setAttribute("profileid", profile.id);
      menuitem.setAttribute("image", await profile.getAvatarURL(48));
      menuitem.style.setProperty("--menu-profiles-theme-bg", themeBg);
      menuitem.style.setProperty("--menu-profiles-theme-fg", themeFg);

      if (profile.id === currentProfile.id) {
        menuitem.classList.add("current");
        menuitem.setAttribute("data-l10n-id", "menu-profiles-current");
        menuitem.setAttribute(
          "data-l10n-args",
          JSON.stringify({ profileName: profile.name })
        );
      } else {
        menuitem.classList.remove("current");
        menuitem.removeAttribute("data-l10n-id");
        menuitem.removeAttribute("data-l10n-args");
        menuitem.setAttribute("label", profile.name);
      }

      if (isNewItem) {
        menuPopup.insertBefore(menuitem, insertionPoint);
      }
    }
    // If there's any old item to remove, do so now.
    for (let remaining of existingItems) {
      remaining.remove();
    }
  }

  manageProfiles() {
    let { toOpenWindowByType } = this.#window;
    return lazy.SelectableProfileService.maybeSetupDataStore().then(() => {
      toOpenWindowByType(
        "about:profilemanager",
        "about:profilemanager",
        "chrome,resizable,toolbar,centerscreen"
      );
    });
  }

  copyProfile() {
    const profile =
      this.#subViewProfile ?? lazy.SelectableProfileService.currentProfile;
    lazy.SelectableProfileService.maybeSetupDataStore().then(() => {
      profile.copyProfile();
    });
  }

  createNewProfile(source) {
    lazy.SelectableProfileService.createNewProfile(true, null, source);
  }

  updateView(target) {
    let { PanelUI } = this.#window;
    const closestPanelView = target.closest("panelview");
    const panelView = closestPanelView
      ? lazy.PanelView.forNode(closestPanelView)
      : null;
    const wasKeyboardActivation = panelView?._doingKeyboardActivation ?? false;
    this.populateSubView();
    if (panelView && wasKeyboardActivation) {
      panelView._doingKeyboardActivation = true;
    }
    PanelUI.showSubView("PanelUI-profiles", target);
  }

  async updateFxAView(target) {
    let { PanelUI } = this.#window;
    const profileId = parseInt(target.getAttribute("profileid"), 10);
    this.#subViewProfile = profileId
      ? await lazy.SelectableProfileService.getProfile(profileId)
      : null;
    this.populateSubView(this.#subViewProfile);
    PanelUI.showSubView("PanelUI-profiles", target);
  }

  launchProfile(aEvent) {
    lazy.SelectableProfileService.getProfile(
      aEvent.target.getAttribute("profileid")
    ).then(profile => {
      lazy.SelectableProfileService.launchInstance(profile);
    });
  }

  async openTabsInProfile(aEvent, tabsToOpen) {
    let profile = await lazy.SelectableProfileService.getProfile(
      aEvent.target.getAttribute("profileid")
    );
    lazy.SelectableProfileService.launchInstance(
      profile,
      tabsToOpen.map(tab => tab.linkedBrowser.currentURI.spec)
    );
  }

  async handleCommand(aEvent) {
    switch (aEvent.target.id) {
      /* App menu button events */
      case "appMenu-profiles-button": {
        this.updateView(aEvent.target);
        break;
      }
      /* FxA menu button events */
      case "PanelUI-fxa-menu-all-profiles-button": {
        aEvent.stopPropagation();
        this.#window.gSync.emitFxaToolbarTelemetry(
          "view_all_profiles",
          aEvent.target
        );
        this.#populateAllProfilesPanel();
        this.#window.PanelUI.showSubView(
          "PanelUI-fxa-menu-all-profiles",
          aEvent.target
        );
        break;
      }
      case "PanelUI-fxa-menu-all-profiles-manage-button": {
        this.#window.gSync.emitFxaToolbarTelemetry(
          "manage_all_profiles",
          aEvent.target
        );
        this.manageProfiles();
        break;
      }
      case "PanelUI-fxa-menu-all-profiles-create-button": {
        this.#window.gSync.emitFxaToolbarTelemetry(
          "create_new_profile_cta_label",
          aEvent.target
        );
        this.createNewProfile("profiles-panel");
        break;
      }
      case "appMenu-create-profile-button":
      // fall through
      case "PanelUI-fxa-menu-create-profile-button": {
        aEvent.stopPropagation();
        this.#window.gSync.emitFxaToolbarTelemetry(
          "create_new_profile_submenu",
          aEvent.target
        );
        this.#window.PanelUI.showSubView(
          "PanelUI-fxa-menu-create-profile",
          aEvent.target
        );
        break;
      }
      case "PanelUI-fxa-menu-create-profile-confirm-button": {
        this.#window.gSync.emitFxaToolbarTelemetry(
          "create_new_profile_cta_button",
          aEvent.target
        );
        this.createNewProfile("profiles-panel");
        break;
      }
      case "PanelUI-fxa-menu-create-profile-learn-more-button": {
        this.#window.gSync.emitFxaToolbarTelemetry(
          "what_are_profiles",
          aEvent.target
        );
        this.#window.openTrustedLinkIn(
          "https://support.mozilla.org/kb/profile-management",
          "tab"
        );
        break;
      }
      case "PanelUI-fxa-menu-create-profile-copy-button": {
        this.#window.gSync.emitFxaToolbarTelemetry(
          "copy_primary_profile",
          aEvent.target
        );
        this.copyProfile();
        break;
      }
      case "PanelUI-fxa-menu-create-profile-manage-button": {
        this.#window.gSync.emitFxaToolbarTelemetry(
          "manage_profiles",
          aEvent.target
        );
        this.manageProfiles();
        break;
      }
      default: {
        if (
          aEvent.target.classList.contains("profile-item") &&
          aEvent.target.classList.contains("subviewbutton-nav")
        ) {
          aEvent.stopPropagation();
          this.#window.gSync.emitFxaToolbarTelemetry(
            "manage_primary_profile",
            aEvent.target
          );
          this.updateFxAView(aEvent.target);
        }
        break;
      }
      /* Subpanel events that may be triggered in FxA menu or app menu */
      case "profiles-appmenu-back-button": {
        aEvent.target.closest("panelview").panelMultiView.goBack();
        aEvent.target.blur();
        break;
      }
      case "profiles-edit-this-profile-button": {
        this.#window.gSync.emitFxaToolbarTelemetry(
          "edit_primary_profile",
          aEvent.target
        );
        this.#window.openTrustedLinkIn("about:editprofile", "tab");
        break;
      }
      case "profiles-manage-profiles-button": {
        this.#window.gSync.emitFxaToolbarTelemetry(
          "manage_profiles",
          aEvent.target
        );
        this.manageProfiles();
        break;
      }
      case "profiles-copy-profile-button": {
        this.#window.gSync.emitFxaToolbarTelemetry(
          "copy_primary_profile",
          aEvent.target
        );
        this.copyProfile();
        break;
      }
      case "profiles-create-profile-button": {
        this.#window.gSync.emitFxaToolbarTelemetry(
          "create_new_profile_cta_label",
          aEvent.target
        );
        this.createNewProfile("profiles-panel");
        break;
      }

      /* Menubar events */
      case "Profiles:CreateProfile": {
        this.createNewProfile("main-menu");
        break;
      }
      case "Profiles:ManageProfiles": {
        this.manageProfiles();
        break;
      }
      case "Profiles:LaunchProfile": {
        this.launchProfile(aEvent.sourceEvent);
        break;
      }
      case "Profiles:MoveTabsToProfile": {
        let tabs;
        if (this.#window.TabContextMenu.contextTab.multiselected) {
          tabs = this.#window.gBrowser.selectedTabs;
        } else {
          tabs = [this.#window.TabContextMenu.contextTab];
        }
        this.openTabsInProfile(aEvent.sourceEvent, tabs);
        break;
      }
    }
    /* Subpanel profile events that may be triggered in FxA menu or app menu */
    if (
      aEvent.target.classList.contains("profile-item") &&
      aEvent.target.hasAttribute("profileid") &&
      aEvent.target.getAttribute("profileid") !==
        String(lazy.SelectableProfileService.currentProfile?.id)
    ) {
      this.#window.gSync.emitFxaToolbarTelemetry(
        aEvent.target.closest("#PanelUI-fxa-menu-all-profiles-list")
          ? "launch_secondary_profile_all_profiles"
          : "launch_secondary_profile",
        aEvent.target
      );
      this.launchProfile(aEvent);
    }
  }

  /**
   * Inserts the subpanel contents for the PanelUI subpanel, which may be shown
   * either in the app menu or the FxA toolbar button menu.
   *
   *   @param {SelectableProfile|null} [displayProfile]
   *   The profile to display in the subview. If null, falls back to the
   *   current profile.
   */
  async populateSubView(displayProfile = null) {
    let { document } = this.#window;
    let profiles = [];
    let currentProfile = null;

    if (lazy.SelectableProfileService.initialized) {
      profiles = await lazy.SelectableProfileService.getAllProfiles();
      currentProfile = lazy.SelectableProfileService.currentProfile;
    }

    const targetProfile = displayProfile ?? currentProfile;
    const showProfileInfo = displayProfile !== null || profiles.length >= 1;

    let subview = lazy.PanelMultiView.getViewNode(document, "PanelUI-profiles");

    let backButton = lazy.PanelMultiView.getViewNode(
      document,
      "profiles-appmenu-back-button"
    );
    backButton.setAttribute(
      "aria-label",
      this.bundle.GetStringFromName("panel.back")
    );
    backButton.style.fill = "var(--appmenu-profiles-theme-fg, currentColor)";

    const subviewBody = subview.querySelector(".panel-subview-body");
    subviewBody.hidden = !targetProfile;

    let currentProfileCard = lazy.PanelMultiView.getViewNode(
      document,
      "current-profile"
    );
    currentProfileCard.hidden = !targetProfile;

    let profilesHeader = lazy.PanelMultiView.getViewNode(
      document,
      "PanelUI-profiles-header"
    );

    let editThisProfileButton = lazy.PanelMultiView.getViewNode(
      document,
      "profiles-edit-this-profile-button"
    );
    if (!editThisProfileButton) {
      editThisProfileButton = document.createXULElement("toolbarbutton");
      editThisProfileButton.id = "profiles-edit-this-profile-button";
      editThisProfileButton.classList.add("subviewbutton");
      editThisProfileButton.setAttribute(
        "data-l10n-id",
        "appmenu-edit-this-profile"
      );
    }

    // Automatically created by PanelMultiView.
    const headerSeparator = profilesHeader.nextElementSibling;
    let footerSeparator = lazy.PanelMultiView.getViewNode(
      document,
      "footer-separator"
    );
    if (!footerSeparator) {
      footerSeparator = document.createXULElement("toolbarseparator");
      footerSeparator.id = "footer-separator";
    }

    let createProfileButton = lazy.PanelMultiView.getViewNode(
      document,
      "profiles-create-profile-button"
    );
    if (!createProfileButton) {
      createProfileButton = document.createXULElement("toolbarbutton");
      createProfileButton.id = "profiles-create-profile-button";
      createProfileButton.classList.add(
        "subviewbutton",
        "panel-subview-footer-button"
      );
      createProfileButton.setAttribute(
        "data-l10n-id",
        "appmenu-create-profile2"
      );
    }

    let copyProfileButton = lazy.PanelMultiView.getViewNode(
      document,
      "profiles-copy-profile-button"
    );

    if (!copyProfileButton) {
      copyProfileButton = document.createXULElement("toolbarbutton");
      copyProfileButton.id = "profiles-copy-profile-button";
      copyProfileButton.classList.add("subviewbutton");
      copyProfileButton.setAttribute("data-l10n-id", "appmenu-copy-profile");
    }

    let manageProfilesButton = lazy.PanelMultiView.getViewNode(
      document,
      "profiles-manage-profiles-button"
    );

    if (!manageProfilesButton) {
      manageProfilesButton = document.createXULElement("toolbarbutton");
      manageProfilesButton.id = "profiles-manage-profiles-button";
      manageProfilesButton.classList.add("subviewbutton");
      manageProfilesButton.setAttribute(
        "data-l10n-id",
        "appmenu-manage-profiles"
      );
    }

    if (targetProfile) {
      let { themeBg, themeFg } = targetProfile.theme;
      subview.style.setProperty("--appmenu-profiles-theme-bg", themeBg);
      subview.style.setProperty("--appmenu-profiles-theme-fg", themeFg);
      profilesHeader.style.backgroundColor = "var(--appmenu-profiles-theme-bg)";
      profilesHeader.style.color = "var(--appmenu-profiles-theme-fg)";

      let headerText = lazy.PanelMultiView.getViewNode(
        document,
        "profiles-header-content"
      );
      headerText.textContent = targetProfile.name;

      let profileIconEl = lazy.PanelMultiView.getViewNode(
        document,
        "profile-icon-image"
      );
      currentProfileCard.style.setProperty(
        "--appmenu-profiles-theme-bg",
        themeBg
      );
      currentProfileCard.style.setProperty(
        "--appmenu-profiles-theme-fg",
        themeFg
      );

      profileIconEl.style.listStyleImage = `url(${await targetProfile.getAvatarURL(80)})`;
    } else {
      profilesHeader.removeAttribute("style");
    }

    if (showProfileInfo) {
      headerSeparator.hidden = true;
      editThisProfileButton.hidden = false;
      subview.appendChild(editThisProfileButton);
      subview.appendChild(copyProfileButton);

      for (let item of subview.querySelectorAll(".profiles-subview-item")) {
        item.remove();
      }
      lazy.PanelMultiView.getViewNode(
        document,
        "profiles-subview-list-start-separator"
      )?.remove();
      lazy.PanelMultiView.getViewNode(
        document,
        "profiles-subview-list-header"
      )?.remove();
      lazy.PanelMultiView.getViewNode(
        document,
        "profiles-subview-list"
      )?.remove();

      let hasOtherProfiles = false;
      if (displayProfile === null) {
        let profilesListStartSeparator =
          document.createXULElement("toolbarseparator");
        profilesListStartSeparator.id = "profiles-subview-list-start-separator";

        subview.appendChild(profilesListStartSeparator);

        let profilesListHeader = document.createXULElement("label");
        profilesListHeader.id = "profiles-subview-list-header";
        profilesListHeader.classList.add("subview-subheader");
        profilesListHeader.setAttribute("crop", "end");
        profilesListHeader.setAttribute(
          "data-l10n-id",
          "appmenu-other-profiles"
        );
        subview.appendChild(profilesListHeader);

        let profilesList = document.createXULElement("vbox");
        profilesList.id = "profiles-subview-list";
        subview.appendChild(profilesList);

        for (let profile of profiles) {
          if (profile.id === targetProfile?.id) {
            continue;
          }
          let btn = document.createXULElement("toolbarbutton");
          btn.classList.add(
            "subviewbutton",
            "subviewbutton-iconic",
            "profile-item",
            "profiles-subview-item"
          );
          btn.setAttribute("profileid", profile.id);
          btn.setAttribute("label", profile.name);
          let { themeBg, themeFg } = profile.theme;
          btn.style.setProperty("--appmenu-profiles-theme-bg", themeBg);
          btn.style.setProperty("--appmenu-profiles-theme-fg", themeFg);
          btn.setAttribute("image", await profile.getAvatarURL(16));
          profilesList.appendChild(btn);
          hasOtherProfiles = true;
        }

        // With no other profiles the list is empty, so hide it and the footer
        // separator to avoid rendering two adjacent separators.
        profilesList.hidden = !hasOtherProfiles;
        profilesListHeader.hidden = !hasOtherProfiles;
      }

      footerSeparator.hidden = displayProfile === null && !hasOtherProfiles;
      subview.appendChild(footerSeparator);

      subview.appendChild(manageProfilesButton);
      subview.appendChild(createProfileButton);
    } else {
      headerSeparator.hidden = false;
      footerSeparator.hidden = true;
      editThisProfileButton.hidden = true;
      subview.insertBefore(editThisProfileButton, subviewBody);
      subview.insertBefore(createProfileButton, subviewBody);
      subview.insertBefore(copyProfileButton, subviewBody);
      subview.insertBefore(manageProfilesButton, subviewBody);
    }
  }

  async populateMoveTabMenu(menuPopup) {
    let { document } = this.#window;
    if (!lazy.SelectableProfileService.initialized) {
      return;
    }

    const profiles = await lazy.SelectableProfileService.getAllProfiles();
    const currentProfile = lazy.SelectableProfileService.currentProfile;

    const separator = document.getElementById("moveTabSeparator");
    separator.hidden = profiles.length < 2;

    let existingItems = [
      ...menuPopup.querySelectorAll(":scope > menuitem[profileid]"),
    ];

    // Place the profile items immediately after the separator, repositioning
    // reused ones too. Anchoring keeps them in their declared slot regardless of
    // any later items in the popup (e.g. Select All Tabs in the alt layout).
    let anchor = separator;
    for (let profile of profiles) {
      if (profile.id === currentProfile.id) {
        continue;
      }

      let menuitem = existingItems.shift();
      if (!menuitem) {
        menuitem = document.createXULElement("menuitem");
        menuitem.setAttribute("tbattr", "tabbrowser-multiple-visible");
        menuitem.setAttribute("data-l10n-id", "move-to-new-profile");
        menuitem.setAttribute("command", "Profiles:MoveTabsToProfile");
      }

      menuitem.disabled = false;
      menuitem.setAttribute("profileid", profile.id);
      menuitem.setAttribute(
        "data-l10n-args",
        JSON.stringify({ profileName: profile.name })
      );

      anchor.after(menuitem);
      anchor = menuitem;
    }
    // If there's any old item to remove, do so now.
    for (let remaining of existingItems) {
      remaining.remove();
    }
  }
}
