package com.fintechmastery.payments;

import org.springframework.dao.CannotAcquireLockException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

/** RFC 9457 problem details. Messages are safe: no stack traces, SQL or internal ids. */
@RestControllerAdvice
public class ApiErrors extends ResponseEntityExceptionHandler {

    @ExceptionHandler(IdempotencyException.class)
    ProblemDetail idempotencyMismatch(IdempotencyException e) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.UNPROCESSABLE_CONTENT, e.getMessage());
        pd.setTitle("Idempotency key reuse");
        return pd;
    }

    @ExceptionHandler(IllegalArgumentException.class)
    ProblemDetail badMoney(IllegalArgumentException e) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Invalid amount or currency");
        pd.setTitle("Invalid request");
        return pd;
    }

    @ExceptionHandler(CannotAcquireLockException.class)
    ProblemDetail busy(CannotAcquireLockException e) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, "Request in progress, retry later");
        pd.setTitle("Concurrent request");
        return pd;
    }
}
