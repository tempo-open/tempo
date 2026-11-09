import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

/** A settings row's choice of a few named values, drawn as one segmented control (settings.css). */
export function SettingsSegmented<Value extends string>(props: {
  readonly label: string;
  readonly value: Value;
  readonly options: ReadonlyArray<readonly [Value, string]>;
  readonly onChange: (value: Value) => void;
}) {
  return (
    <ToggleGroup
      aria-label={props.label}
      data-tempo-settings-segmented=""
      value={[props.value]}
      onValueChange={(next) => {
        const option = props.options.find(([value]) => value === next[0]);
        if (option) props.onChange(option[0]);
      }}
    >
      {props.options.map(([value, label]) => (
        <Toggle key={value} value={value}>
          {label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
