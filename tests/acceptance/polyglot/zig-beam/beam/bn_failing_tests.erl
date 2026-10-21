-module(bn_failing_tests).

-include_lib("eunit/include/eunit.hrl").

deliberate_failure_test() ->
    ?assertEqual(1, 2).
