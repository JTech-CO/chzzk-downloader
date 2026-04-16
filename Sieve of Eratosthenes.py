# 소수 찾기 프로그램 (Sieve of Eratosthenes)
# 1부터 n까지의 소수를 찾고, 개수와 합을 계산합니다.

def find_primes(n):
    # n+1 크기의 리스트를 True로 초기화 (모두 소수 후보)
    is_prime = [True] * (n + 1)
    is_prime[0] = is_prime[1] = False  # 0과 1은 소수가 아님
    
    # 에라토스테네스의 체 알고리즘 적용
    for i in range(2, int(n**0.5) + 1):
        if is_prime[i]:
            # i의 배수들을 모두 소수가 아니라고 표시
            for j in range(i*i, n+1, i):
                is_prime[j] = False
    
    # 소수 리스트 생성
    primes = [i for i in range(2, n+1) if is_prime[i]]
    return primes


# 메인 로직
if __name__ == "__main__":
    n = 100                     # 1부터 찾을 최대 숫자
    
    primes = find_primes(n)     # 소수 찾기 함수 호출
    
    print(f"1부터 {n}까지의 소수 목록:")
    print(primes)               # 소수 리스트 출력
    
    prime_count = len(primes)   # 소수의 개수
    prime_sum = sum(primes)     # 소수의 합
    
    print(f"\n소수의 개수: {prime_count}개")
    print(f"소수의 합: {prime_sum}")