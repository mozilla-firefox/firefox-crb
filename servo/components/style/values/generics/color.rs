/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Generic types for color properties.

use crate::color::ColorMixItemList;
use crate::color::{AbsoluteColor, ColorFunction, mix::ColorInterpolationMethod};
use crate::derives::*;
use crate::values::generics::Optional;
use crate::values::{
    ParseError, Parser, computed::Percentage as ComputedPercentage, computed::ToComputedValue,
    specified::percentage::ToPercentage,
};
use std::fmt::{self, Write};
use style_traits::{CssWriter, ToCss, owned_slice::OwnedSlice};

/// This struct represents a combined color from a numeric color and
/// the current foreground color (currentcolor keyword).
#[derive(Clone, Debug, MallocSizeOf, PartialEq, ToAnimatedValue, ToShmem)]
#[repr(C)]
pub enum GenericColor<Percentage> {
    /// The actual numeric color.
    Absolute(AbsoluteColor),
    /// A unresolvable color.
    ColorFunction(Box<ColorFunction<Self>>),
    /// The `CurrentColor` keyword.
    CurrentColor,
    /// The color-mix() function.
    ColorMix(Box<GenericColorMix<Self, Percentage>>),
    /// The contrast-color() function.
    ContrastColor(Box<Self>),
}

/// Determines how color-mix items are interpreted and how the result is finalized.
///
/// CSS color mixing and weighted animation composition have different
/// semantics, even though they share the mixing machinery.
#[derive(Clone, Copy, Debug, MallocSizeOf, PartialEq, ToShmem)]
#[repr(u8)]
pub enum ColorMixKind {
    /// An authored CSS `color-mix()`.
    ///
    /// Item percentages are contributions to the whole mix. Normalize them by
    /// their total, reducing the result's alpha when the total is below 100%.
    /// Always produce modern color syntax, including when all inputs are legacy
    /// colors, to preserve floating-point precision and out-of-gamut values.
    Css,

    /// A mix that uses caller-supplied weights directly. This includes animation
    /// interpolation, addition, and accumulation, as well as gradient color
    /// interpolation through `Servo_InterpolateColor`.
    ///
    /// Normalizing the weights would turn addition into averaging.
    /// Finalize the result as legacy sRGB when all inputs use legacy syntax.
    Weighted,

    /// Successive interpolations stored as an initial color followed by targets
    /// with progress values. Each step mixes the previous result with its target.
    InterpolationSequence,
}

impl ColorMixKind {
    /// Whether this kind produces modern color syntax.
    #[inline]
    pub fn result_is_in_modern_syntax(&self) -> bool {
        matches!(self, Self::Css)
    }

    /// Whether item weights are normalized by their total.
    #[inline]
    pub fn normalizes_weights(&self) -> bool {
        matches!(self, Self::Css)
    }
}

/// One `(color, percentage)` component of a `color-mix()` expression.
#[derive(
    Clone,
    Debug,
    MallocSizeOf,
    PartialEq,
    ToAnimatedValue,
    ToComputedValue,
    ToResolvedValue,
    ToShmem,
)]
#[allow(missing_docs)]
#[repr(C)]
pub struct GenericColorMixItem<Color, Percentage> {
    pub color: Color,
    /// [Optional::None] when the percentage was omitted next to a calc() sibling.
    pub percentage: Optional<Percentage>,
}

/// A restricted version of the css `color-mix()` function, which only supports
/// percentages.
///
/// https://drafts.csswg.org/css-color-5/#color-mix
#[derive(
    Clone,
    Debug,
    MallocSizeOf,
    PartialEq,
    ToAnimatedValue,
    ToComputedValue,
    ToResolvedValue,
    ToShmem,
)]
#[allow(missing_docs)]
#[repr(C)]
pub struct GenericColorMix<Color, Percentage> {
    pub interpolation: ColorInterpolationMethod,
    pub items: OwnedSlice<GenericColorMixItem<Color, Percentage>>,
    pub kind: ColorMixKind,
}

pub use self::GenericColorMix as ColorMix;

impl<Color: ToCss, Percentage: ToCss + ToPercentage> ToCss for ColorMix<Color, Percentage> {
    fn to_css<W>(&self, dest: &mut CssWriter<W>) -> fmt::Result
    where
        W: Write,
    {
        // We special case serialization for now. See:
        // - https://bugzilla.mozilla.org/show_bug.cgi?id=2095524
        // - https://github.com/w3c/csswg-drafts/issues/14829
        if self.kind == ColorMixKind::InterpolationSequence {
            return self.interpolation_to_css(dest);
        }

        dest.write_str("color-mix(")?;

        // If the color interpolation method is oklab (which is now the default),
        // it can be omitted.
        // See: https://github.com/web-platform-tests/interop/issues/1166
        if !self.interpolation.is_default() {
            self.interpolation.to_css(dest)?;
            dest.write_str(", ")?;
        }

        let uniform_value = 1.0 / self.items.len() as f32;

        // Per https://drafts.csswg.org/css-color-5/#serial-color-mix: omit every
        // percentage iff all are known (specified, non-calc) and equal to 100%/N.
        let omit_all = self.items.iter().all(|item| {
            item.percentage
                .as_ref()
                .is_some_and(|p| !p.is_calc() && p.to_percentage() == Some(uniform_value))
        });

        for (index, item) in self.items.iter().enumerate() {
            if index != 0 {
                dest.write_str(", ")?;
            }

            item.color.to_css(dest)?;

            if omit_all {
                continue;
            }

            // An omitted percentage next to a calc() sibling serializes to nothing.
            if let Some(percentage) = item.percentage.as_ref() {
                dest.write_char(' ')?;
                percentage.to_css(dest)?;
            }
        }

        dest.write_char(')')
    }
}

impl<Color: ToCss, Percentage: ToCss + ToPercentage> ColorMix<Color, Percentage> {
    /// Serialize an interpolation as the equivalent nested two-item
    /// color-mix() functions.
    fn interpolation_to_css<W>(&self, dest: &mut CssWriter<W>) -> fmt::Result
    where
        W: Write,
    {
        let Some((start, steps)) = self.items.split_first() else {
            return Ok(());
        };
        for _ in steps {
            dest.write_str("color-mix(")?;
            self.interpolation.to_css(dest)?;
            dest.write_str(", ")?;
        }
        start.color.to_css(dest)?;
        for step in steps {
            let weight = step.percentage.as_ref();
            let accumulated_weight = weight.and_then(|w| w.to_percentage()).map(|w| 1.0 - w);
            let omit = accumulated_weight == Some(0.5)
                && weight.is_some_and(|w| !w.is_calc() && w.to_percentage() == Some(0.5));
            if let Some(accumulated_weight) = accumulated_weight.filter(|_| !omit) {
                dest.write_char(' ')?;
                ComputedPercentage(accumulated_weight).to_css(dest)?;
            }
            dest.write_str(", ")?;
            step.color.to_css(dest)?;
            if let Some(weight) = weight.filter(|_| !omit) {
                dest.write_char(' ')?;
                weight.to_css(dest)?;
            }
            dest.write_char(')')?;
        }
        Ok(())
    }
}

impl<Color, Percentage> ColorMix<Color, Percentage> {
    /// Mix the colors, resolving each of them with `resolve`. Returns `None`
    /// if a color can't be resolved, or a weight can't be resolved to a
    /// number.
    pub fn mix_resolved(
        &self,
        mut resolve: impl FnMut(&Color) -> Option<AbsoluteColor>,
    ) -> Option<AbsoluteColor>
    where
        Percentage: ToPercentage,
    {
        use crate::color::mix;

        if self.kind == ColorMixKind::InterpolationSequence {
            let (start, steps) = self.items.split_first()?;
            let mut accumulated = resolve(&start.color)?;
            for step in steps {
                let weight = step.percentage.as_ref()?.to_percentage()?;
                accumulated = mix::interpolation_step(
                    self.interpolation,
                    accumulated,
                    resolve(&step.color)?,
                    weight,
                );
            }
            return Some(accumulated);
        }

        let fill = self.omitted_weight()?;

        let mut items = ColorMixItemList::with_capacity(self.items.len());
        for item in self.items.iter() {
            let weight = match item.percentage.as_ref() {
                Some(percentage) => percentage.to_percentage()?,
                None => fill,
            };
            items.push(mix::ColorMixItem::new(resolve(&item.color)?, weight))
        }

        Some(mix::mix_many(self.interpolation, &items, self.kind))
    }
}

impl<Color, Percentage> ColorMix<Color, Percentage> {
    /// The weight used for percentages that were omitted next to a calc()
    /// sibling: an equal share of the weight not taken by specified percentages.
    /// Returns `None` if a specified percentage can't be resolved to a number.
    pub(crate) fn omitted_weight(&self) -> Option<f32>
    where
        Percentage: ToPercentage,
    {
        let mut specified_sum = 0.0;
        let mut omitted = 0;
        for item in self.items.iter() {
            match item.percentage.as_ref() {
                Some(p) => specified_sum += p.to_percentage()?,
                None => omitted += 1,
            }
        }
        Some(if omitted > 0 {
            (1.0 - specified_sum).max(0.0) / omitted as f32
        } else {
            0.0
        })
    }
}

impl<Percentage> ColorMix<GenericColor<Percentage>, Percentage> {
    /// Mix the colors into a single absolute color. Return `None` if any input
    /// color is non-absolute or any percentage cannot be resolved.
    pub fn mix_to_absolute(&self) -> Option<AbsoluteColor>
    where
        Percentage: ToPercentage,
    {
        self.mix_resolved(|color| color.as_absolute().copied())
    }
}

pub use self::GenericColor as Color;

impl<Percentage> Color<Percentage> {
    /// If this color is absolute return it's value, otherwise return None.
    pub fn as_absolute(&self) -> Option<&AbsoluteColor> {
        match *self {
            Self::Absolute(ref absolute) => Some(absolute),
            _ => None,
        }
    }

    /// Returns a color value representing currentcolor.
    pub fn currentcolor() -> Self {
        Self::CurrentColor
    }

    /// Whether it is a currentcolor value (no numeric color component).
    pub fn is_currentcolor(&self) -> bool {
        matches!(*self, Self::CurrentColor)
    }

    /// Whether this color is an absolute color.
    pub fn is_absolute(&self) -> bool {
        matches!(*self, Self::Absolute(..))
    }
}

/// Either `<color>` or `auto`.
#[derive(
    Animate,
    Clone,
    ComputeSquaredDistance,
    Copy,
    Debug,
    MallocSizeOf,
    PartialEq,
    Parse,
    SpecifiedValueInfo,
    ToAnimatedValue,
    ToAnimatedZero,
    ToComputedValue,
    ToResolvedValue,
    ToCss,
    ToShmem,
    ToTyped,
)]
#[repr(C, u8)]
pub enum GenericColorOrAuto<C> {
    /// A `<color>`.
    Color(C),
    /// `auto`
    Auto,
}

pub use self::GenericColorOrAuto as ColorOrAuto;

/// Caret color is effectively a ColorOrAuto, but resolves `auto` to
/// currentColor.
#[derive(
    Animate,
    Clone,
    ComputeSquaredDistance,
    Copy,
    Debug,
    MallocSizeOf,
    PartialEq,
    SpecifiedValueInfo,
    ToAnimatedValue,
    ToAnimatedZero,
    ToComputedValue,
    ToCss,
    ToShmem,
    ToTyped,
)]
#[repr(transparent)]
pub struct GenericCaretColor<C>(pub GenericColorOrAuto<C>);

impl<C> GenericCaretColor<C> {
    /// Returns the `auto` value.
    pub fn auto() -> Self {
        GenericCaretColor(GenericColorOrAuto::Auto)
    }
}

pub use self::GenericCaretColor as CaretColor;

/// A light-dark(<light>, <dark>) function.
#[derive(
    Clone, Debug, MallocSizeOf, PartialEq, SpecifiedValueInfo, ToShmem, ToCss, ToResolvedValue,
)]
#[css(function = "light-dark", comma)]
#[repr(C)]
pub struct GenericLightDark<T> {
    /// The value returned when using a light theme.
    pub light: T,
    /// The value returned when using a dark theme.
    pub dark: T,
}

impl<T> GenericLightDark<T> {
    /// Parse the arguments of the light-dark() function.
    pub fn parse_args_with(
        input: &mut Parser,
        mut parse_one: impl FnMut(&mut Parser) -> Result<T, ParseError>,
    ) -> Result<Self, ParseError> {
        let light = parse_one(input)?;
        input.expect_comma()?;
        let dark = parse_one(input)?;
        Ok(Self { light, dark })
    }

    /// Parse the light-dark() function.
    pub fn parse_with(
        input: &mut Parser,
        parse_one: impl FnMut(&mut Parser) -> Result<T, ParseError>,
    ) -> Result<Self, ParseError> {
        input.expect_function_matching("light-dark")?;
        input.parse_nested_block(|input| Self::parse_args_with(input, parse_one))
    }
}

impl<T: ToComputedValue> GenericLightDark<T> {
    /// Choose the light or dark version of this value for computation purposes, and compute it.
    pub fn compute(&self, cx: &crate::values::computed::Context) -> T::ComputedValue {
        let dark = cx.device().is_dark_color_scheme(cx.builder.color_scheme);
        if cx.for_non_inherited_property {
            cx.rule_cache_conditions
                .borrow_mut()
                .set_color_scheme_dependency(cx.builder.color_scheme);
        }
        let chosen = if dark { &self.dark } else { &self.light };
        chosen.to_computed_value(cx)
    }
}
