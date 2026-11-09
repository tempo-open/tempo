/**
 * tempo: the host computer use helper, compiled by the Command Line Tools' clang on first use. Kept as
 * source, every host builds the same short program it can read. `displays` counts online displays;
 * `virtual-display <width> <height>` holds a virtual display while it runs, for a monitorless Mac;
 * `disclaim <path> [args]` runs a program as its own responsible process, with its own grants.
 */
export const HOST_HELPER_SOURCE = String.raw`#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/message.h>
#include <spawn.h>
#include <signal.h>
#include <sys/wait.h>

extern char **environ;
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim)
    __attribute__((weak_import));

static uint32_t onlineDisplays(void) {
  CGDirectDisplayID ids[32];
  uint32_t count = 0;
  if (CGGetOnlineDisplayList(32, ids, &count) != kCGErrorSuccess) return 0;
  return count;
}

static pid_t child = 0;
static void forward(int sig) { if (child > 0) kill(child, sig); }

static int disclaim(int argc, char **argv) {
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  if (responsibility_spawnattrs_setdisclaim == NULL) {
    fprintf(stderr, "tempo-host-helper: this macOS cannot disclaim responsibility\n");
    return 70;
  }
  responsibility_spawnattrs_setdisclaim(&attr, 1);
  signal(SIGTERM, forward);
  signal(SIGINT, forward);
  signal(SIGHUP, forward);
  int error = posix_spawn(&child, argv[0], NULL, &attr, argv, environ);
  posix_spawnattr_destroy(&attr);
  if (error != 0) {
    fprintf(stderr, "tempo-host-helper: could not start %s: %s\n", argv[0], strerror(error));
    return 71;
  }
  int status = 0;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) return 72;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 128 + WTERMSIG(status);
}

static void stop(int sig) { (void)sig; exit(0); }

static int virtualDisplay(unsigned width, unsigned height) {
  Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
  Class displayClass = NSClassFromString(@"CGVirtualDisplay");
  Class settingsClass = NSClassFromString(@"CGVirtualDisplaySettings");
  Class modeClass = NSClassFromString(@"CGVirtualDisplayMode");
  if (!descriptorClass || !displayClass || !settingsClass || !modeClass) {
    fprintf(stderr, "tempo-host-helper: this macOS has no virtual display support\n");
    return 73;
  }
  id descriptor = [[descriptorClass alloc] init];
  [descriptor setValue:dispatch_get_main_queue() forKey:@"queue"];
  [descriptor setValue:@"Tempo Virtual Display" forKey:@"name"];
  [descriptor setValue:@(width) forKey:@"maxPixelsWide"];
  [descriptor setValue:@(height) forKey:@"maxPixelsHigh"];
  CGSize millimeters = CGSizeMake(width * 25.4 / 96.0, height * 25.4 / 96.0);
  [descriptor setValue:[NSValue valueWithBytes:&millimeters objCType:@encode(CGSize)]
                forKey:@"sizeInMillimeters"];
  [descriptor setValue:@(0xE3) forKey:@"vendorID"];
  [descriptor setValue:@(0xE301) forKey:@"productID"];
  [descriptor setValue:@(1) forKey:@"serialNum"];
  id display = ((id (*)(id, SEL, id))objc_msgSend)(
      [displayClass alloc], NSSelectorFromString(@"initWithDescriptor:"), descriptor);
  if (!display) {
    fprintf(stderr, "tempo-host-helper: macOS refused to create a virtual display\n");
    return 74;
  }
  id mode = ((id (*)(id, SEL, NSUInteger, NSUInteger, double))objc_msgSend)(
      [modeClass alloc], NSSelectorFromString(@"initWithWidth:height:refreshRate:"), width,
      height, 60.0);
  id settings = [[settingsClass alloc] init];
  [settings setValue:@[ mode ] forKey:@"modes"];
  [settings setValue:@(0) forKey:@"hiDPI"];
  BOOL applied = ((BOOL (*)(id, SEL, id))objc_msgSend)(
      display, NSSelectorFromString(@"applySettings:"), settings);
  if (!applied) {
    fprintf(stderr, "tempo-host-helper: macOS refused the virtual display's mode\n");
    return 75;
  }
  signal(SIGTERM, stop);
  signal(SIGINT, stop);
  printf("ready %u\n", ((uint32_t (*)(id, SEL))objc_msgSend)(display, NSSelectorFromString(@"displayID")));
  fflush(stdout);
  // The display lasts as long as this process holds it.
  dispatch_main();
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc >= 2 && strcmp(argv[1], "displays") == 0) {
      printf("%u\n", onlineDisplays());
      return 0;
    }
    if (argc >= 4 && strcmp(argv[1], "virtual-display") == 0) {
      return virtualDisplay((unsigned)atoi(argv[2]), (unsigned)atoi(argv[3]));
    }
    if (argc >= 3 && strcmp(argv[1], "disclaim") == 0) {
      return disclaim(argc - 2, argv + 2);
    }
    fprintf(stderr, "usage: tempo-host-helper displays | virtual-display <width> <height> | disclaim <path> [args...]\n");
    return 64;
  }
}
`;
