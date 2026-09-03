// Reports launches of the Codex application on stdout, one line per launch:
//   launch <pid> flagged|unflagged
// "flagged" means the process was started with --remote-debugging-port, so
// the host can already attach; "unflagged" launches get relaunched by the host.
#import <AppKit/AppKit.h>
#include <string.h>
#include <sys/sysctl.h>

static BOOL processHasDebuggingPort(pid_t pid) {
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) < 0 || size == 0) {
    return NO;
  }
  char *buffer = malloc(size);
  if (buffer == NULL || sysctl(mib, 3, buffer, &size, NULL, 0) < 0) {
    free(buffer);
    return NO;
  }
  static const char needle[] = "--remote-debugging-port=";
  BOOL found = memmem(buffer, size, needle, sizeof(needle) - 1) != NULL;
  free(buffer);
  return found;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *bundleIdentifier =
        argc > 1 ? [NSString stringWithUTF8String:argv[1]] : @"com.openai.codex";
    NSNotificationCenter *center = [[NSWorkspace sharedWorkspace] notificationCenter];
    [center addObserverForName:NSWorkspaceWillLaunchApplicationNotification
                        object:nil
                         queue:nil
                    usingBlock:^(NSNotification *note) {
                      NSRunningApplication *app = note.userInfo[NSWorkspaceApplicationKey];
                      if (![app.bundleIdentifier isEqualToString:bundleIdentifier]) {
                        return;
                      }
                      pid_t pid = app.processIdentifier;
                      printf("launch %d %s\n", pid,
                             processHasDebuggingPort(pid) ? "flagged" : "unflagged");
                      fflush(stdout);
                    }];
    printf("ready\n");
    fflush(stdout);
    [[NSRunLoop currentRunLoop] run];
  }
  return 0;
}
