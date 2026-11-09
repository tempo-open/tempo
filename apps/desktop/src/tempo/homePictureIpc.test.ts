import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readPicture, removePicture, writePicture } from "./homePictureIpc.ts";

describe("home picture file", () => {
  it.effect("saves, replaces and removes the one picture", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-home-picture-" }),
          "home-picture.webp",
        );
        assert.isNull(yield* readPicture(file));

        assert.isTrue(yield* writePicture(file, new Uint8Array([1, 2, 3])));
        assert.deepStrictEqual(yield* readPicture(file), new Uint8Array([1, 2, 3]));

        assert.isTrue(yield* writePicture(file, new Uint8Array([4, 5])));
        assert.deepStrictEqual(yield* readPicture(file), new Uint8Array([4, 5]));
        assert.deepStrictEqual(yield* fileSystem.readDirectory(path.dirname(file)), [
          "home-picture.webp",
        ]);

        assert.isFalse(yield* writePicture(file, new Uint8Array()));
        assert.deepStrictEqual(yield* readPicture(file), new Uint8Array([4, 5]));

        yield* removePicture(file);
        assert.isNull(yield* readPicture(file));
        yield* removePicture(file);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
