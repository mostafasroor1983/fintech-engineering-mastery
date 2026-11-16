package com.fintechmastery.wallet;

import jakarta.persistence.LockModeType;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface AccountRepository extends JpaRepository<Account, Long> {

    Optional<Account> findByPublicId(UUID publicId);

    Optional<Account> findByOwnerIdAndCurrencyAndType(String ownerId, String currency, AccountType type);

    /**
     * Locks the rows (SELECT ... FOR UPDATE / FOR NO KEY UPDATE) in ascending id order.
     * Every transaction locks in the same global order, so A->B and B->A cannot deadlock.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select a from Account a where a.id in :ids order by a.id")
    List<Account> lockInIdOrder(@Param("ids") Collection<Long> ids);
}
