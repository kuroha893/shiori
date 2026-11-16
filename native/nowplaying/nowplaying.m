// What macOS says is playing, and play/pause/next/previous for whichever app it is.
//
// Since macOS 15.4 an ordinary process gets nothing back from MediaRemote. Apple's own /usr/bin/perl may still use it,
// so nowplaying.pl loads this library into perl and calls one of the functions below. The approach comes from
// ungive/mediaremote-adapter (BSD 3-Clause, Copyright (c) 2025, Jonas van den Berg and contributors); this is a small
// rewrite of the part Shiori needs.
//
//   shiori_get   prints one JSON line: app, playing, title, artist, album, duration, elapsed, artwork (base64)
//   shiori_send  sends the command in SHIORI_NP_COMMAND (0 play, 1 pause, 2 toggle, 4 next, 5 previous)
//
// MediaRemote's change notifications don't arrive this way on macOS 26, and a process that stays open keeps getting
// the same answer, so Shiori asks again with a fresh process each time.
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <dlfcn.h>

typedef void (*GetInfo)(dispatch_queue_t, void (^)(NSDictionary *));
typedef void (*GetPID)(dispatch_queue_t, void (^)(int));
typedef void (*GetPlaying)(dispatch_queue_t, void (^)(BOOL));
typedef bool (*Send)(unsigned int, id);

static void *mr(const char *name) {
  static void *h;
  if (!h) h = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_NOW);
  return h ? dlsym(h, name) : NULL;
}

static void print(NSDictionary *out) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static NSString *key(NSString *k) { return [@"kMRMediaRemoteNowPlayingInfo" stringByAppendingString:k]; }

void shiori_get(void) {
  @autoreleasepool {
    GetInfo getInfo = (GetInfo)mr("MRMediaRemoteGetNowPlayingInfo");
    GetPID getPID = (GetPID)mr("MRMediaRemoteGetNowPlayingApplicationPID");
    GetPlaying getPlaying = (GetPlaying)mr("MRMediaRemoteGetNowPlayingApplicationIsPlaying");
    if (!getInfo || !getPID || !getPlaying) return print(@{ @"error" : @"unavailable" });

    dispatch_queue_t q = dispatch_queue_create("shiori.nowplaying", DISPATCH_QUEUE_SERIAL);
    __block NSDictionary *info = nil;
    __block int pid = 0;
    __block BOOL playing = NO;
    dispatch_group_t g = dispatch_group_create();
    dispatch_group_enter(g);
    getInfo(q, ^(NSDictionary *i) { info = i; dispatch_group_leave(g); });
    dispatch_group_enter(g);
    getPID(q, ^(int p) { pid = p; dispatch_group_leave(g); });
    dispatch_group_enter(g);
    getPlaying(q, ^(BOOL p) { playing = p; dispatch_group_leave(g); });
    if (dispatch_group_wait(g, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC)) != 0) return print(@{ @"error" : @"timeout" });

    NSMutableDictionary *out = [NSMutableDictionary dictionary];
    NSRunningApplication *app = pid ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
    if (app.bundleIdentifier) out[@"app"] = app.bundleIdentifier;
    if (app.localizedName) out[@"appName"] = app.localizedName;
    out[@"playing"] = @(playing);
    for (NSString *k in @[ @"Title", @"Artist", @"Album" ]) {
      id v = info[key(k)];
      if ([v isKindOfClass:NSString.class]) out[k.lowercaseString] = v;
    }
    NSNumber *duration = info[key(@"Duration")], *elapsed = info[key(@"ElapsedTime")], *rate = info[key(@"PlaybackRate")];
    NSDate *stamp = info[key(@"Timestamp")];
    if ([duration isKindOfClass:NSNumber.class]) out[@"duration"] = duration;
    if ([elapsed isKindOfClass:NSNumber.class]) {
      double e = elapsed.doubleValue;
      // The elapsed time is as of the timestamp; carry it on to now at the playback rate.
      if ([stamp isKindOfClass:NSDate.class] && rate.doubleValue > 0) e += -[stamp timeIntervalSinceNow] * rate.doubleValue;
      out[@"elapsed"] = @(e);
    }
    NSData *art = info[key(@"ArtworkData")];
    if ([art isKindOfClass:NSData.class] && art.length) {
      out[@"artwork"] = [art base64EncodedStringWithOptions:0];
      id type = info[key(@"ArtworkMIMEType")];
      out[@"artworkType"] = [type isKindOfClass:NSString.class] ? type : @"image/jpeg";
    }
    print(out);
  }
}

void shiori_send(void) {
  @autoreleasepool {
    Send send = (Send)mr("MRMediaRemoteSendCommand");
    GetPID getPID = (GetPID)mr("MRMediaRemoteGetNowPlayingApplicationPID");
    const char *c = getenv("SHIORI_NP_COMMAND");
    bool sent = send && c && send((unsigned int)atoi(c), nil);
    // The command travels asynchronously; a process that exits at once loses it. A round trip after it means it is out.
    if (sent && getPID) {
      dispatch_group_t g = dispatch_group_create();
      dispatch_group_enter(g);
      getPID(dispatch_queue_create("shiori.nowplaying", DISPATCH_QUEUE_SERIAL), ^(int pid) { dispatch_group_leave(g); });
      dispatch_group_wait(g, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
    }
    print(@{ @"sent" : @(sent) });
  }
}
