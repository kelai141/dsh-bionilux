-module(bn_nif_tests).

-include_lib("eunit/include/eunit.hrl").

joint_test() ->
    %% 106 (Zig -> C and Zig -> Rust -> C) + 85 (Rust -> C)
    %% + 90 (the low seven bits of the mixed seed path).
    ?assertEqual(281, bn_nif:joint(20, 22)).

describe_test() ->
    ?assertEqual("rust(c:85)", bn_nif:describe()).
