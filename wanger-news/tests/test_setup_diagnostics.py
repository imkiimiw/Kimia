"""Setup mistakes the owner can make in GitHub, and what the bot says about them."""

from __future__ import annotations

import pytest

from wanger_news.settings import Settings, describe_db_error, token_problems

TOKEN = "123456789:AAH" + "x" * 32


def settings(**env: str) -> Settings:
    return Settings(_env_file=None, **env)  # type: ignore[call-arg]


@pytest.mark.parametrize(
    "pasted",
    [
        TOKEN,
        f"  {TOKEN}\n",
        f'"{TOKEN}"',
        f"bot{TOKEN}",
        f"Done! Congratulations on your new bot.\nUse this token to access the HTTP API:\n{TOKEN}\n"
        "Keep your token secure and store it safely.",
        f"https://api.telegram.org/bot{TOKEN}/getMe",
    ],
)
def test_the_token_is_found_in_common_pastes(pasted: str) -> None:
    token = settings(bot_token=pasted).bot_token
    assert token is not None and token.get_secret_value() == TOKEN


def test_what_is_wrong_with_a_token_is_said_without_showing_it() -> None:
    assert token_problems(TOKEN) == []
    hints = token_problems("my bot token")
    assert any("spaces" in h for h in hints) and any("':'" in h for h in hints)
    assert any("too short" in h for h in token_problems("123:abc"))
    assert any("digits only" in h for h in token_problems("abc:" + "x" * 40))
    for hint in token_problems("secretvalue-that-is-not-a-token"):
        assert "secretvalue" not in hint


def test_a_neon_psql_snippet_is_accepted() -> None:
    url = "postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require"
    value = settings(database_url=f"psql '{url}'").database_url
    assert value is not None and value.get_secret_value() == url


def test_database_errors_in_one_line_without_secrets() -> None:
    auth = describe_db_error(
        Exception(
            "connection failed: ERROR:  password authentication failed for user 'neondb_owner'"
        )
    )
    assert auth.startswith("the database rejected the password")
    assert "neondb_owner" not in auth
    assert "host name is wrong" in describe_db_error(
        Exception('could not translate host name "x" to address')
    )
    assert describe_db_error(ValueError("boom")) == "cannot connect to the database (ValueError)"


async def test_a_database_that_refuses_is_a_message_not_a_crash() -> None:
    from wanger_news.cli import _revision_problem

    problem = await _revision_problem(
        settings(database_url="postgresql://u:secret@127.0.0.1:1/none?connect_timeout=2")
    )
    assert problem is not None and problem.startswith("cannot connect to the database")
    assert "secret" not in problem
