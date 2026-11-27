# Feature Callout

## Table of Contents

- [Feature Callouts](#feature-callouts)
  - [Content Elements](#content-elements)
  - [Arrow Positioning](#arrow-positioning)
- [Use Cases](#use-cases)
- [Examples](#examples)
- [Testing Feature Callouts](#testing-feature-callouts)
  - [Via The DevTools](#via-the-devtools)
  - [Via Local Provider](#via-local-provider)
  - [Via Experiments](#via-experiments)
- [Schema](#schema)
- [Example JSON](#example-json)
- [Targeting](#targeting)
  - [Targeting Considerations](#targeting-considerations)
- [Triggers](#triggers)
- [Special Message Actions](#special-message-actions)

## Feature Callouts

Feature Callouts point to and describe features in content pages or the browser chrome. They can consist of a single message or of a sequence of messages. Callouts are different from [Spotlights](./spotlight.md) or other dialogs in that they do not block other interactions with the browser. Feature Callouts are currently only available for experimentation in the browser chrome. For example, callouts can easily be configured to point to toolbar buttons in the browser chrome.

### Content Elements

Callouts may be configured with the following content elements (each of which is optional):

- title
- subtitle
- inline title icon
- a large illustration above the title
- primary action button
- secondary action button
- additional action button
- dismiss button
- checkboxes and/or radio buttons

### Arrow Positioning

The callout's arrow (the triangle-shaped caret pointing to the anchor) can be positioned in the middle or in the corners of any of the callout's edges, and it can be anchored to the same positions on its anchor element. The arrow position and anchor position can each be placed at the start, middle, or end of any given side of the callout or anchor respectively. Although the syntax for arrow and anchor positioning includes "left" and "right", the positions will be adjusted appropriately for left-to-right text directions, and this should be configured as if for right-to-left text directions. The arrow can also be hidden entirely. There is also an optional effect to highlight the button the callout is anchored to. This highlight only works if the anchor element is a button.

## Use Cases

Feature Callouts have been used in a variety of ways. Some common use cases are:

- Highlighting underused functionality
- Displaying short surveys
- Displaying informative toast messages
- Guiding users through new features

## Examples

A Feature Callout highlighting a feature

![Feature Callout](./feature-callout.png)

A Feature Callout displaying a user feedback survey

![Feature Callout Survey](./feature-callout-survey.png)

## Testing Feature Callouts

### Via the devtools:

1. Go to `about:config`, set pref `browser.newtabpage.activity-stream.asrouter.devtoolsEnabled` to `true`
2. Open a new tab and go to `about:asrouter` in the urlbar
3. In the devtools Messages section, search for `feature_callout` using the findbar
4. You should see an example JSON message labeled `TEST_FEATURE_TOUR`. Clicking `Show` next to it should show the callout
5. You can directly modify the message in the text area with your changes or by pasting your custom message JSON. Clicking `Modify` shows your updated message. Make sure it's valid JSON and be careful not to add unnecessary commas after the final member in an array or the final property of an object, as they will invalidate the message.
6. For these testing purposes, targeting and trigger are ignored, as the message will be triggered by pressing the "Modify" button. So you won't be able to test triggers and targeting by this method.
7. Ensure that all required properties are covered according to the schema below
8. Clicking `Share` copies a link to your clipboard that can be pasted in the urlbar to preview the message and can be shared to get feedback from your team

- **Note:** Only one Feature Callout can be shown at a time. You must dismiss existing callouts before new ones can be shown.

### Via local provider:

You can also test Feature Callouts by adding them to the [local provider](https://searchfox.org/firefox-main/source/browser/components/asrouter/modules/FeatureCalloutMessages.sys.mjs). While slower than using the devtools, this is useful when you want to test the trigger or targeting, or when your callout's anchor is an element that is not visible while on `about:asrouter` (such as a urlbar button).

PropTypes are defined for the `content` prop in the screen renderer component in [`MultiStageProtonScreen.jsx`](https://searchfox.org/firefox-main/source/browser/components/asrouter/content-src/components/MultiStageProtonScreen.jsx). In order to check your Feature Callout message against the defined PropTypes, you can ensure that the PropTypes validation test passes inside the unit tests in [`MultiStageAWProton.test.jsx`](https://searchfox.org/firefox-main/source/browser/components/asrouter/tests/unit/content-src/components/MultiStageAWProton.test.jsx). See [here](/browser/components/asrouter/docs/building-and-testing.md#running-unit-tests) for more on running unit tests.

### Via Experiments:

You can test Feature Callouts by creating an experiment or landing message in tree. [Messaging Journey](https://experimenter.info/messaging/desktop-messaging-journey) captures creating and testing experiments via Nimbus. This is the most time-consuming method, but if your callout will be launched as an experiment, then it also provides the most accurate preview.

## Schema

See JSON schema for a multistage screen content [here](https://searchfox.org/firefox-main/source/toolkit/components/messaging-system/schemas/MultiStageProtonScreenSchemas/MultiStageProtonScreenSchemas.json), which the Messaging System renders Feature Callouts from.

## Example JSON

```json
{
  "id": "TEST_FEATURE_TOUR",
  "template": "feature_callout",
  "groups": [],
  "targeting": "true",
  "content": {
    "id": "TEST_FEATURE_TOUR",
    "template": "multistage",
    "backdrop": "transparent",
    "transitions": false,
    "disableHistoryUpdates": true,
    "screens": [
      {
        "id": "FEATURE_CALLOUT_1",
        "anchors": [
          {
            "selector": "#PanelUI-menu-button",
            "panel_position": {
              "anchor_attachment": "bottomcenter",
              "callout_attachment": "topright"
            }
          }
        ],
        "content": {
          "position": "callout",
          "title": {
            "raw": "Panel Feature Callout"
          },
          "subtitle": {
            "raw": "Hello!"
          },
          "primary_button": {
            "label": {
              "raw": "Advance"
            },
            "action": {
              "navigate": true
            }
          },
          "dismiss_button": {
            "action": {
              "dismiss": true
            }
          }
        }
      }
    ]
  }
}
```

## Targeting

Messages use JEXL targeting expressions to determine whether the user is eligible to see the message. See [Guide to targeting with JEXL](./targeting-guide.md) and [Targeting attributes](./targeting-attributes.md) for details.

### Targeting Considerations

In almost all cases, targeting should prevent the Feature Callout from showing up while other notifications are being displayed and also prevent it from showing up when the browser is first started after a major upgrade. The JEXL expressions are `!activeNotifcations` and `!isMajorUpgrade` for these scenarios respectively.

Feature Callouts are also often used to contextually recommend new features to users. In these cases, the JEXL expression `userPrefs.cfrFeatures` should be included in the targeting to prevent the Callout from appearing for users who have turned contextual feature recommendations off. It is also common to add `previousSessionEnd` to the targeting to ensure that users opening the browser for the first time ever don't see the message on their first run.

## Triggers

Triggers are used to determine when a message should be shown. See [Trigger Listeners](/toolkit/components/messaging-system/docs/TriggerActionSchemas/index.md) for details.

## Special Message Actions

Buttons, links, and other calls to action can use one or more of a set of predefined actions. [Click here](/toolkit/components/messaging-system/docs/SpecialMessageActionSchemas/index.md) for a full list of valid actions.
