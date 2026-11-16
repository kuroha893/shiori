# Runs one function of libShioriNowPlaying inside Apple's perl, which macOS still lets read what is playing.
# Usage: /usr/bin/perl nowplaying.pl /absolute/path/libShioriNowPlaying.dylib get|send [command]
use strict;
use warnings;
use DynaLoader;

my ($lib, $what, $command) = @ARGV;
die "usage: nowplaying.pl <dylib> get|send [command]\n" unless $lib && $what && $what =~ /^(get|send)$/;
$ENV{SHIORI_NP_COMMAND} = $command if defined $command;

my $handle = DynaLoader::dl_load_file($lib, 0) or die "cannot load $lib: " . DynaLoader::dl_error() . "\n";
my $symbol = DynaLoader::dl_find_symbol($handle, "shiori_$what") or die "no shiori_$what in $lib\n";
DynaLoader::dl_install_xsub("main::run", $symbol);
main::run();
