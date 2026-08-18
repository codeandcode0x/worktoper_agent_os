#define _GNU_SOURCE

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  char runtime_directory[PATH_MAX];
  ssize_t path_length = readlink("/proc/self/exe", runtime_directory, sizeof(runtime_directory) - 1);
  if (path_length < 0) {
    perror("readlink /proc/self/exe");
    return errno || 1;
  }
  runtime_directory[path_length] = '\0';

  char *separator = strrchr(runtime_directory, '/');
  if (!separator) {
    fputs("Unable to resolve bundled QEMU directory\n", stderr);
    return 1;
  }
  *separator = '\0';

  const char *executable_name = strrchr(argv[0], '/');
  executable_name = executable_name ? executable_name + 1 : argv[0];

  char loader[PATH_MAX];
  char library_directory[PATH_MAX];
  char module_directory[PATH_MAX];
  char target[PATH_MAX];
  snprintf(loader, sizeof(loader), "%s/lib/ld-musl-x86_64.so.1", runtime_directory);
  snprintf(library_directory, sizeof(library_directory), "%s/lib", runtime_directory);
  snprintf(module_directory, sizeof(module_directory), "%s/lib/qemu", runtime_directory);
  snprintf(target, sizeof(target), "%s/libexec/%s", runtime_directory, executable_name);
  setenv("QEMU_MODULE_DIR", module_directory, 1);

  char **launch_arguments = calloc((size_t)argc + 4, sizeof(char *));
  if (!launch_arguments) {
    perror("calloc");
    return errno || 1;
  }
  launch_arguments[0] = loader;
  launch_arguments[1] = "--library-path";
  launch_arguments[2] = library_directory;
  launch_arguments[3] = target;
  for (int index = 1; index < argc; index += 1) {
    launch_arguments[index + 3] = argv[index];
  }

  execv(loader, launch_arguments);
  perror("Unable to launch bundled QEMU");
  return errno || 1;
}
