import { describe, expect, it } from "vite-plus/test";

import { reposVolumeSetupCommand } from "./reposVolume.logic";

describe("reposVolumeSetupCommand", () => {
  it("runs the script with macOS's bash", () => {
    expect(
      reposVolumeSetupCommand("/Users/person/.tempo/userdata/repos-volume/repos-volume.sh"),
    ).toBe("/bin/bash '/Users/person/.tempo/userdata/repos-volume/repos-volume.sh'");
  });

  it("keeps spaces, dollars and quotes in the path from reaching the shell", () => {
    expect(reposVolumeSetupCommand("/Users/o'brien/my $HOME/`x`/s.sh")).toBe(
      "/bin/bash '/Users/o'\\''brien/my $HOME/`x`/s.sh'",
    );
  });
});
