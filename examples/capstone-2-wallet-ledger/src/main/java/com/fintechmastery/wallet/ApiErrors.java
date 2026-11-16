package com.fintechmastery.wallet;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

@RestControllerAdvice
public class ApiErrors extends ResponseEntityExceptionHandler {

    @ExceptionHandler(InsufficientFundsException.class)
    ProblemDetail insufficient(InsufficientFundsException e) {
        return problem(HttpStatus.UNPROCESSABLE_CONTENT, "Insufficient funds", "The source wallet balance is too low");
    }

    @ExceptionHandler(QuoteUnavailableException.class)
    ProblemDetail quote(QuoteUnavailableException e) {
        return problem(HttpStatus.CONFLICT, "Quote unavailable", e.getMessage());
    }

    @ExceptionHandler(UnknownAccountException.class)
    ProblemDetail unknown(UnknownAccountException e) {
        return problem(HttpStatus.NOT_FOUND, "Account not found", "No such account");
    }

    @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class})
    ProblemDetail invalid(RuntimeException e) {
        return problem(HttpStatus.BAD_REQUEST, "Invalid request", e.getMessage());
    }

    private static ProblemDetail problem(HttpStatus status, String title, String detail) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(status, detail);
        pd.setTitle(title);
        return pd;
    }
}
