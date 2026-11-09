import { CheckIcon, CircleCheckIcon, type LucideProps } from "lucide-react";

import { cn } from "~/lib/utils";

/**
 * A success mark: the circled check in the classic look, a plain check stroke in the tempo look.
 * The look's CSS variant picks one, so the toasts need no settings import (the settings import them).
 */
export function SuccessCheckIcon({ className, ...props }: LucideProps) {
  return (
    <>
      <CircleCheckIcon className={cn(className, "tempo:hidden")} {...props} />
      <CheckIcon className={cn(className, "hidden tempo:block")} {...props} />
    </>
  );
}
