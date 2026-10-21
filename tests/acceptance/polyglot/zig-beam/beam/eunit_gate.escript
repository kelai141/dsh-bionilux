#!/usr/bin/env escript
%%! -noshell

%% eunit:test/1,2 returns the atom error on failure. A shell that only checks
%% that the VM started treats that as success. This wrapper turns the atom
%% into a distinct exit code and prints the raw result for the log.
main([Spec]) ->
    Mods = [list_to_atom(M) || M <- string:split(Spec, ",", all)],
    Result = eunit:test(Mods, [verbose]),
    io:format("EUNIT_RESULT=~p~n", [Result]),
    case Result of
        ok -> halt(0);
        error -> halt(2);
        {error, _} -> halt(2);
        Other -> io:format("EUNIT_UNEXPECTED=~p~n", [Other]), halt(3)
    end;
main(_) ->
    io:format("usage: eunit_gate.escript Module[,Module...]~n"),
    halt(64).
