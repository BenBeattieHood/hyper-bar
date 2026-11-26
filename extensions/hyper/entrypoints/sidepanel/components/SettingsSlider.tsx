import type { ComponentProps, CSSProperties } from 'react';

interface SettingsSliderProps {
  id: string;
  inputProps: ComponentProps<'input'> & { max: number; min: number; step: number; value: number };
  maxLabel: string;
  minLabel: string;
}

/** The values a stepped slider can stop at, each with its share of the thumb's travel. */
export function sliderStops(min: number, max: number, step: number) {
  return Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, index) => {
    const value = min + index * step;
    return { share: (value - min) / (max - min), value };
  });
}

const shareStyle = (share: number) => ({ '--settings-slider-share': share }) as CSSProperties;

/**
 * A stepped range input on a drawn rail with a dot at each stop, each dot the
 * colour of the rail where it sits. The input paints only its thumb, above the
 * rail, so the thumb covers the dot it rests on.
 */
export function SettingsSlider({ id, inputProps, maxLabel, minLabel }: SettingsSliderProps) {
  const { max, min, step, value } = inputProps;
  const stops = sliderStops(min, max, step);
  const railStyle = {
    '--settings-slider-intervals': stops.length - 1,
    '--settings-slider-share': (value - min) / (max - min),
  } as CSSProperties;
  const dots = (filled: boolean) =>
    stops
      .filter((stop) => (stop.value < value) === filled)
      .map((stop) => (
        <span key={stop.value} className="settings-slider-dot" style={shareStyle(stop.share)} />
      ));
  return (
    <span className="settings-slider">
      <span className="settings-slider-control">
        <span className="settings-slider-rail" aria-hidden="true" style={railStyle}>
          <span className="settings-slider-fill">{dots(true)}</span>
          <span className="settings-slider-rest">{dots(false)}</span>
        </span>
        <input id={id} {...inputProps} />
      </span>
      <span className="settings-slider-scale" aria-hidden="true">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </span>
    </span>
  );
}
