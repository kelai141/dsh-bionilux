-module(bn_nif).

-export([joint/2, describe/0]).
-on_load(init/0).

init() ->
    Path = os:getenv("BN_NIF_PATH", "bn_nif"),
    case erlang:load_nif(Path, 0) of
        ok -> ok;
        {error, {reload, _}} -> ok;
        {error, Reason} -> erlang:error({nif_load_failed, Path, Reason})
    end.

joint(_, _) -> erlang:nif_error(nif_not_loaded).
describe() -> erlang:nif_error(nif_not_loaded).
